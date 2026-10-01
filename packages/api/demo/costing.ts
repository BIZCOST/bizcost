import { createHash } from 'node:crypto'
import type {
  BooksDto,
  BusinessContextDto,
  CostCategoryListDto,
  ExpenseDto,
  ExpensePaymentsDto,
  ExpenseSettingsDto,
  LocationDto,
  MaterialDto,
  MemberDto,
  ProductDto,
  PurchaseDto,
  PurchasePaymentsDto,
  PurchaseReturnDto,
  RecipeDto,
  RunningCostDto,
  SupplierDto,
  WithMeta,
} from '@bizcost/contracts'
import { compareDecimal, STANDARD_UNITS, type Locale, type StandardUnit } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import { appCodeOf, type DemoApi } from './client'
import type {
  DemoCategory,
  DemoCosting,
  DemoExpense,
  DemoMaterial,
  DemoPack,
  DemoPayment,
  DemoPurchase,
  DemoReturn,
  UnitOrPack,
} from './costing-data'

// The Costing Core part of `pnpm demo:seed` (docs/ARCHITECTURE.md §Local setup › Demo data): each
// demo business's suppliers, materials, products & services, recipes, purchases (posted, so the stock
// ledger, the averages and the audit log are real), returns and credit notes, payments, running costs,
// expenses and the owner's time, entered through the API as its owner (and as a member where a member
// would enter it), only in the modules the business has on.
//
// Idempotent: every record's id is derived from the business and the record's key, and each is read
// before it is written, so a second run adds nothing and a run cut short is completed by the next one.
// Documents are dated back from the business's today and entered in date order (as if on the day);
// nothing is dated in the future and the books are never closed. A record that cannot be written (the
// owner changed the business since) is reported and skipped; the rest goes on.

type Envelope<T> = WithMeta<T>

export interface CostingSummary {
  business: string
  materials: string
  products: string
  purchases: string
  runningCosts: string
  expenses: string
}

export interface CostingResult {
  summary: CostingSummary
  /** What was skipped and why. */
  notes: string[]
  /** Records that could not be written. */
  warnings: string[]
}

export interface CostingContext {
  readonly api: DemoApi
  /** The owner's token and business. */
  readonly token: string
  readonly businessId: string
  /** The business's name in the summary. */
  readonly label: string
  /** The business's language: the starter categories are named in it. */
  readonly locale: Locale
  /** A token for a demo member of the business (who enters an expense). */
  readonly tokenOf: (email: string) => Promise<string>
}

/**
 * A stable id for a record of a demo business: a v8 UUID from a hash of the business and the key, so
 * a second run finds what the first one made (the demo's exception to client UUIDv7 ids, D-185).
 */
export function demoId(businessId: string, key: string): string {
  const hex = createHash('sha256').update(`bizcost-demo:${businessId}:${key}`).digest('hex')
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

/** YYYY-MM-DD `days` days after `day` (negative: before). */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** YYYY-MM-DD of the first day of the month `months` months after the month of `day`. */
function monthStart(day: string, months: number): string {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + months)
  return date.toISOString().slice(0, 10)
}

const isStandardUnit = (value: string): value is StandardUnit => value in STANDARD_UNITS

const VAT_RATE = '5'

/** A document entered on its day; on the same day: purchases, expenses, returns, then payments. */
interface TimelineEvent {
  order: number
  daysAgo: number
  label: string
  run: () => Promise<void>
}

class CostingSeed {
  private readonly notes: string[] = []
  private readonly warnings: string[] = []
  private modules = new Set<string>()
  private capabilities: Record<string, boolean> = {}
  private today = ''
  private readonly materials = new Map<string, Pick<DemoMaterial, 'key' | 'packs'>>()
  private members = new Map<string, string>()
  private locations = new Map<string, string>()
  private categories = new Map<string, string>()

  constructor(
    private readonly ctx: CostingContext,
    private readonly data: DemoCosting,
  ) {
    for (const material of data.materials ?? []) this.materials.set(material.key, material)
    for (const product of data.products ?? []) {
      if (product.resale) this.materials.set(product.resale.key, product.resale)
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Calls as the owner (or another member)
  // -------------------------------------------------------------------------------------------------

  private id(key: string): string {
    return demoId(this.ctx.businessId, key)
  }

  private query<T>(path: string, input?: unknown, token = this.ctx.token): Promise<T> {
    return this.ctx.api.query<T>(path, token, this.ctx.businessId, input)
  }

  private mutate<T>(path: string, input?: unknown, token = this.ctx.token): Promise<T> {
    return this.ctx.api.mutate<T>(path, token, this.ctx.businessId, input)
  }

  /** A record by id, or undefined when there is none. */
  private async find<T>(path: string, input: unknown): Promise<T | undefined> {
    try {
      return await this.query<T>(path, input)
    } catch (error) {
      if (appCodeOf(error) === 'not_found') return undefined
      throw error
    }
  }

  /** Runs one record's writes; a failure is reported and the seed goes on. */
  private async attempt(label: string, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error) {
      this.warnings.push(
        `${this.ctx.label}: ${label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private active(...modules: string[]): boolean {
    return modules.every((id) => this.modules.has(id))
  }

  private day(daysAgo: number): string {
    return addDays(this.today, -daysAgo)
  }

  private get vatRegistered(): boolean {
    return this.capabilities.vat_registered === true
  }

  /**
   * VAT on a document: the standard rate on a tax invoice of a VAT-registered business. Any other
   * business types what it paid, before VAT, as the app's forms send it (the API refuses the rest).
   */
  private vatOf(document: string): { vatRate: string; pricesIncludeVat: boolean } {
    if (!this.vatRegistered) return { vatRate: '0', pricesIncludeVat: false }
    return document === 'tax_invoice'
      ? { vatRate: VAT_RATE, pricesIncludeVat: false }
      : { vatRate: '0', pricesIncludeVat: true }
  }

  /** As the app's forms: a tax invoice when VAT-registered, else another invoice or receipt. */
  private defaultDocument(): 'tax_invoice' | 'non_tax_invoice' {
    return this.vatRegistered ? 'tax_invoice' : 'non_tax_invoice'
  }

  /** A quantity in a standard unit or in one of the material's packs. */
  private unitOf(
    materialKey: string,
    unit: UnitOrPack,
  ): { unit: StandardUnit } | { packId: string } {
    if (isStandardUnit(unit)) return { unit }
    const material = this.materials.get(materialKey)
    if (!material?.packs?.some((p) => p.key === unit)) {
      throw new Error(`demo data: ${materialKey} has no unit or pack "${unit}"`)
    }
    return { packId: this.packId(materialKey, unit) }
  }

  private packId(materialKey: string, packKey: string): string {
    return this.id(`material:${materialKey}:pack:${packKey}`)
  }

  private packsInput(materialKey: string, packs: readonly DemoPack[] = []) {
    return packs.map((p) => ({
      id: this.packId(materialKey, p.key),
      name: p.name,
      qty: p.qty,
      ...(isStandardUnit(p.of) ? { ofUnit: p.of } : { ofPackId: this.packId(materialKey, p.of) }),
    }))
  }

  private materialId(key: string): string {
    return this.id(`material:${key}`)
  }

  private supplierId(key: string | undefined): string | null {
    return key === undefined ? null : this.id(`supplier:${key}`)
  }

  private memberId(email: string | undefined): string | null {
    if (email === undefined) return null
    const id = this.members.get(email.toLowerCase())
    if (!id) throw new Error(`${email} is not an active member`)
    return id
  }

  // -------------------------------------------------------------------------------------------------
  // The business
  // -------------------------------------------------------------------------------------------------

  private async load(): Promise<void> {
    const context = await this.query<BusinessContextDto>('business.context')
    this.modules = new Set(context.modules.map((m) => m.id))
    this.capabilities = context.capabilities
    this.today = (await this.query<BooksDto>('books.get')).today
    // Members who paid something themselves (a team only), and branches (several locations only).
    if (this.capabilities.has_team) {
      const members = await this.query<MemberDto[]>('member.list')
      this.members = new Map(
        members.flatMap((m) =>
          m.status === 'active' && m.email ? [[m.email.toLowerCase(), m.id] as const] : [],
        ),
      )
    }
    if (this.capabilities.multi_location) {
      const locations = await this.query<LocationDto[]>('location.list')
      this.locations = new Map(locations.map((l) => [l.name, l.id]))
    }
  }

  private skipUnless(what: string, count: number, ...modules: string[]): boolean {
    if (count === 0) return true
    if (this.active(...modules)) return false
    const off = modules.filter((id) => !this.modules.has(id)).join(', ')
    this.notes.push(`${this.ctx.label}: ${what} skipped (${off} off for this business)`)
    return true
  }

  // -------------------------------------------------------------------------------------------------
  // Catalog: suppliers, materials, products & services, recipes
  // -------------------------------------------------------------------------------------------------

  private async suppliers(): Promise<void> {
    const suppliers = this.data.suppliers ?? []
    if (this.skipUnless('suppliers', suppliers.length, 'suppliers')) return
    for (const s of suppliers) {
      await this.attempt(`supplier ${s.key}`, async () => {
        const id = this.id(`supplier:${s.key}`)
        if (await this.find<SupplierDto>('supplier.get', { id })) return
        await this.mutate('supplier.create', {
          id,
          name: s.name,
          phone: s.phone ?? null,
          trn: this.vatRegistered ? (s.trn ?? null) : null,
        })
      })
    }
  }

  private async materialsStep(): Promise<void> {
    const materials = this.data.materials ?? []
    if (this.skipUnless('materials', materials.length, 'materials')) return
    for (const m of materials) {
      await this.attempt(`material ${m.key}`, async () => {
        const id = this.materialId(m.key)
        if (await this.find<MaterialDto>('material.get', { id })) return
        await this.mutate('material.create', {
          id,
          name: m.name,
          unit: m.unit,
          packs: this.packsInput(m.key, m.packs),
          crossFactors: (m.cross ?? []).map((c) => ({
            id: this.id(`material:${m.key}:cross:${c.unit}`),
            ...c,
          })),
        })
      })
    }
  }

  /** The owner's time can be saved: Step 6 is built, and the business works without a team (D-119). */
  private ownerTimeAvailable(): boolean {
    return (
      this.ctx.api.hasProcedure('productCost.updateSettings') &&
      this.active('cost_engine') &&
      this.capabilities.has_team !== true
    )
  }

  private async products(): Promise<void> {
    const products = this.data.products ?? []
    if (this.skipUnless('products & services', products.length, 'products')) return
    const withTime = this.ownerTimeAvailable()
    for (const p of products) {
      if (p.resale && this.skipUnless(`${p.key} (bought ready to sell)`, 1, 'materials')) continue
      await this.attempt(`product ${p.key}`, async () => {
        const id = this.id(`product:${p.key}`)
        if (await this.find<ProductDto>('product.get', { id })) return
        await this.mutate('product.create', {
          id,
          name: p.name,
          type: p.type ?? 'product',
          unit: p.unit,
          defaultPrice: p.price,
          vatCategory: 'standard',
          priceIncludesVat: this.vatRegistered && p.priceIncludesVat === true,
          ...(withTime && p.ownerMinutes ? { ownerMinutes: p.ownerMinutes } : {}),
          locationIds: [],
          resale: p.resale
            ? {
                materialId: this.materialId(p.resale.key),
                packs: this.packsInput(p.resale.key, p.resale.packs),
              }
            : null,
        })
      })
    }
  }

  private async recipes(): Promise<void> {
    const recipes = this.data.recipes ?? []
    if (this.skipUnless('recipes', recipes.length, 'products', 'materials')) return
    for (const r of recipes) {
      await this.attempt(`recipe ${r.product}`, async () => {
        const productId = this.id(`product:${r.product}`)
        const recipe = await this.query<Envelope<RecipeDto>>('recipe.get', { productId })
        if (recipe.data.version > 0) return
        await this.mutate('recipe.save', {
          productId,
          version: 0,
          ...(r.makes ? { yieldQty: r.makes } : {}),
          lines: r.lines.map(([material, qty, unit]) => ({
            id: this.id(`recipe:${r.product}:${material}`),
            materialId: this.materialId(material),
            qty,
            ...this.unitOf(material, unit),
          })),
        })
      })
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Documents, in date order
  // -------------------------------------------------------------------------------------------------

  private purchaseLineId(purchaseKey: string, materialKey: string): string {
    return this.id(`purchase:${purchaseKey}:line:${materialKey}`)
  }

  private async purchase(p: DemoPurchase): Promise<void> {
    const id = this.id(`purchase:${p.key}`)
    let doc = (await this.find<Envelope<PurchaseDto>>('purchase.get', { id }))?.data
    if (!doc) {
      const document = p.document ?? this.defaultDocument()
      const { vatRate, pricesIncludeVat } = this.vatOf(document)
      let locationId: string | null = null
      if (p.branch) {
        locationId = this.locations.get(p.branch) ?? null
        if (!locationId) throw new Error(`no location "${p.branch}"`)
      }
      doc = (
        await this.mutate<Envelope<PurchaseDto>>('purchase.create', {
          id,
          supplierId: this.supplierId(p.supplier),
          businessDate: this.day(p.daysAgo),
          documentType: document,
          reference: p.reference ?? null,
          paymentMethod: p.payment,
          paidByMemberId: null,
          pricesIncludeVat,
          locationId,
          lines: p.lines.map(([material, qty, unit, price]) => ({
            kind: 'material',
            id: this.purchaseLineId(p.key, material),
            materialId: this.materialId(material),
            qty,
            ...this.unitOf(material, unit),
            unitPrice: price,
            vatRate,
          })),
        })
      ).data
    }
    if (doc.status === 'draft') {
      await this.mutate('purchase.post', { id, version: doc.version })
    }
  }

  private async purchaseReturn(r: DemoReturn): Promise<void> {
    const id = this.id(`return:${r.key}`)
    let doc = (await this.find<Envelope<PurchaseReturnDto>>('purchaseReturn.get', { id }))?.data
    if (!doc) {
      doc = (
        await this.mutate<Envelope<PurchaseReturnDto>>('purchaseReturn.create', {
          id,
          purchaseId: this.id(`purchase:${r.purchase}`),
          kind: r.kind,
          businessDate: this.day(r.daysAgo),
          reference: r.reference ?? null,
          notes: r.notes ?? null,
          lines: r.lines.map(([material, value]) => ({
            id: this.id(`return:${r.key}:line:${material}`),
            purchaseLineId: this.purchaseLineId(r.purchase, material),
            ...(r.kind === 'return' ? { qty: value } : { amount: value }),
          })),
        })
      ).data
    }
    if (doc.status === 'draft') {
      await this.mutate('purchaseReturn.post', { id, version: doc.version })
    }
  }

  private async payment(pay: DemoPayment): Promise<void> {
    const id = this.id(`payment:${pay.key}`)
    const [path, documentField, documentId] = pay.purchase
      ? (['purchasePayment', 'purchaseId', this.id(`purchase:${pay.purchase}`)] as const)
      : (['expensePayment', 'expenseId', this.id(`expense:${pay.expense}`)] as const)
    const current = await this.query<PurchasePaymentsDto | ExpensePaymentsDto>(`${path}.list`, {
      [documentField]: documentId,
    })
    if (current.data.payments.some((p) => p.id === id)) return
    const amount = pay.amount === 'outstanding' ? (current.data.outstanding ?? '0') : pay.amount
    if (compareDecimal(amount, '0') <= 0) return
    await this.mutate(`${path}.record`, {
      id,
      [documentField]: documentId,
      businessDate: this.day(pay.daysAgo),
      method: pay.method,
      amount,
      note: pay.note ?? null,
    })
  }

  private async expense(e: DemoExpense): Promise<void> {
    const id = this.id(`expense:${e.key}`)
    let doc = (await this.find<Envelope<ExpenseDto>>('expense.get', { id }))?.data
    if (!doc) {
      const document = e.document ?? this.defaultDocument()
      const { vatRate, pricesIncludeVat } = this.vatOf(document)
      const token = e.enteredBy ? await this.ctx.tokenOf(e.enteredBy) : this.ctx.token
      await this.mutate(
        'expense.create',
        {
          id,
          categoryId: await this.categoryId(e.category),
          supplierId: this.supplierId(e.supplier),
          businessDate: this.day(e.daysAgo),
          documentType: document,
          reference: e.reference ?? null,
          description: e.description,
          paymentMethod: e.payment,
          paidByMemberId: this.memberId(e.paidBy),
          pricesIncludeVat,
          locationId: null,
          amount: e.amount,
          vatRate,
        },
        token,
      )
      doc = (await this.query<Envelope<ExpenseDto>>('expense.get', { id })).data
    }
    if (e.approval) {
      // Who entered it sends it for approval (approval turned on first), once: a draft only.
      if (doc.status === 'draft') {
        await this.requireApproval()
        const author = e.enteredBy ? await this.ctx.tokenOf(e.enteredBy) : this.ctx.token
        doc = (
          await this.mutate<Envelope<ExpenseDto>>(
            'expense.submit',
            { id, version: doc.version },
            author,
          )
        ).data
      }
      if (e.approval === 'waiting') return
      if (doc.status === 'submitted') {
        doc = (
          await this.mutate<Envelope<ExpenseDto>>(
            'expense.approve',
            { id, version: doc.version },
            await this.ctx.tokenOf(e.approval.by),
          )
        ).data
      }
    }
    // The owner finalizes it (with approval on, the owner's finalizing approves it too, D-164).
    if (['draft', 'submitted', 'approved'].includes(doc.status)) {
      await this.mutate('expense.post', { id, version: doc.version })
    }
  }

  /** Expenses need approval (D-164): turned on when an expense is first sent for it. */
  private async requireApproval(): Promise<void> {
    const settings = await this.query<ExpenseSettingsDto>('expense.settings')
    if (!settings.approvalRequired) await this.mutate('expense.updateSettings', { approval: true })
  }

  private async documents(): Promise<void> {
    const events: TimelineEvent[] = []
    const purchases = this.data.purchases ?? []
    const returns = this.data.returns ?? []
    const payments = this.data.payments ?? []
    const expenses = this.data.expenses ?? []
    const purchasing = !this.skipUnless(
      'purchases, returns and their payments',
      purchases.length + returns.length + payments.filter((p) => p.purchase).length,
      'purchases',
      'materials',
    )
    const spending = !this.skipUnless('expenses and their payments', expenses.length, 'expenses')
    if (purchasing) {
      for (const p of purchases) {
        events.push({
          order: 0,
          daysAgo: p.daysAgo,
          label: `purchase ${p.key}`,
          run: () => this.purchase(p),
        })
      }
      for (const r of returns) {
        events.push({
          order: 2,
          daysAgo: r.daysAgo,
          label: `${r.kind} ${r.key}`,
          run: () => this.purchaseReturn(r),
        })
      }
    }
    if (spending) {
      for (const e of expenses) {
        events.push({
          order: 1,
          daysAgo: e.daysAgo,
          label: `expense ${e.key}`,
          run: () => this.expense(e),
        })
      }
    }
    for (const pay of payments) {
      if ((pay.purchase && !purchasing) || (pay.expense && !spending)) continue
      events.push({
        order: 3,
        daysAgo: pay.daysAgo,
        label: `payment ${pay.key}`,
        run: () => this.payment(pay),
      })
    }
    events.sort((a, b) => b.daysAgo - a.daysAgo || a.order - b.order)
    for (const event of events) await this.attempt(event.label, event.run)
  }

  // -------------------------------------------------------------------------------------------------
  // Running costs, categories and the owner's time
  // -------------------------------------------------------------------------------------------------

  private async loadCategories(): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.query<CostCategoryListDto>('costCategory.list', {
        status: 'active',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      for (const c of page.items) this.categories.set(c.name, c.id)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }

  /** A live category by name: a starter one in the business's language, or one added (D-172). */
  private async categoryId(category: DemoCategory): Promise<string> {
    const name =
      typeof category === 'string'
        ? createI18n({ locale: this.ctx.locale, namespaces: ['setup'] }).t(
            `setup.cost_categories.${category}` as I18nKey,
          )
        : category.name
    const existing = this.categories.get(name)
    if (existing) return existing
    const id = this.id(`category:${name}`)
    await this.mutate('costCategory.create', { id, name })
    this.categories.set(name, id)
    return id
  }

  private async runningCosts(): Promise<void> {
    const costs = this.data.runningCosts ?? []
    if (this.skipUnless('running costs', costs.length, 'running_costs')) return
    // Regular costs the business has paid since well before its first purchase.
    const startsOn = monthStart(this.today, -8)
    for (const c of costs) {
      await this.attempt(`running cost ${c.key}`, async () => {
        const id = this.id(`running-cost:${c.key}`)
        if (await this.find<Envelope<RunningCostDto>>('runningCost.get', { id })) return
        await this.mutate('runningCost.create', {
          id,
          name: c.name,
          categoryId: await this.categoryId(c.category),
          amount: c.amount,
          frequency: c.frequency ?? 'monthly',
          startsOn,
          endsOn: null,
        })
      })
    }
  }

  private async ownerTime(): Promise<void> {
    const rate = this.data.ownerHourlyRate
    if (!rate) return
    if (!this.ctx.api.hasProcedure('productCost.updateSettings')) {
      this.notes.push(`${this.ctx.label}: the owner's time skipped (Step 6 is not built yet)`)
      return
    }
    if (!this.ownerTimeAvailable()) {
      this.notes.push(`${this.ctx.label}: the owner's time skipped (cost_engine off or a team)`)
      return
    }
    await this.attempt('hourly rate', async () => {
      const settings =
        await this.query<Envelope<{ ownerHourlyRate: string | null }>>('productCost.settings')
      if (settings.data.ownerHourlyRate !== null) return
      await this.mutate('productCost.updateSettings', { ownerHourlyRate: rate })
    })
    // Products made before Step 6 was built get their minutes now (productCost.get shows them, with
    // or without the Materials module).
    const timed = (this.data.products ?? []).filter((p) => p.ownerMinutes)
    if (timed.length === 0 || !this.active('products')) return
    await this.attempt('owner minutes', async () => {
      for (const p of timed) {
        const id = this.id(`product:${p.key}`)
        const cost = await this.find<Envelope<{ cost: { ownerTime: { minutes: string | null } } }>>(
          'productCost.get',
          { productId: id },
        )
        if (!cost || cost.data.cost.ownerTime.minutes !== null) continue
        const product = await this.query<ProductDto>('product.get', { id })
        await this.mutate('product.update', {
          id,
          version: product.version,
          name: product.name,
          description: product.description,
          type: product.type,
          unit: product.unit,
          defaultPrice: product.defaultPrice,
          vatCategory: product.vatCategory,
          priceIncludesVat: product.priceIncludesVat,
          ownerMinutes: p.ownerMinutes,
          locationIds: product.locationIds,
        })
      }
    })
  }

  // -------------------------------------------------------------------------------------------------
  // The summary
  // -------------------------------------------------------------------------------------------------

  private async count(
    path: string,
    input: Record<string, unknown>,
    envelope: boolean,
  ): Promise<number> {
    let total = 0
    let cursor: string | undefined
    do {
      const answer = await this.query<unknown>(path, {
        ...input,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      const page = (envelope ? (answer as Envelope<unknown>).data : answer) as {
        items: unknown[]
        nextCursor: string | null
      }
      total += page.items.length
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return total
  }

  private async summary(): Promise<CostingSummary> {
    const counted = async (
      module: string,
      path: string,
      input: Record<string, unknown>,
      envelope: boolean,
    ) => (this.active(module) ? String(await this.count(path, input, envelope)) : '—')
    return {
      business: this.ctx.label,
      materials: await counted('materials', 'material.list', { status: 'all' }, false),
      products: await counted('products', 'product.list', { status: 'all' }, false),
      purchases: await counted('purchases', 'purchase.list', { status: 'posted' }, true),
      runningCosts: await counted('running_costs', 'runningCost.list', { state: 'all' }, true),
      expenses: await counted('expenses', 'expense.list', { status: 'posted' }, true),
    }
  }

  async run(): Promise<CostingResult> {
    await this.load()
    await this.loadCategories()
    await this.suppliers()
    await this.materialsStep()
    await this.products()
    await this.recipes()
    await this.runningCosts()
    await this.documents()
    await this.ownerTime()
    return { summary: await this.summary(), notes: this.notes, warnings: this.warnings }
  }
}

/** Adds the business's Costing Core data (what is missing of it) through the API. */
export function seedCosting(ctx: CostingContext, data: DemoCosting): Promise<CostingResult> {
  return new CostingSeed(ctx, data).run()
}
