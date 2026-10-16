import { createHash } from 'node:crypto'
import type {
  BooksDto,
  BusinessContextDto,
  ChannelStatementListDto,
  ChannelStatementResultDto,
  CostCategoryListDto,
  CustomerDto,
  CustomerPaymentListDto,
  ExpenseDto,
  ExpensePaymentsDto,
  ExpenseSettingsDto,
  LocationDto,
  MaterialDto,
  MemberDto,
  OrderDto,
  ProductDto,
  PurchaseDto,
  PurchasePaymentsDto,
  PurchaseReturnDto,
  RecipeDto,
  RunningCostDto,
  SaleDto,
  SaleImportDto,
  SalesChannelDto,
  SupplierDto,
  WithMeta,
} from '@bizcost/contracts'
import { IMPORT_ROWS_CHUNK } from '@bizcost/contracts'
import {
  compareDecimal,
  IMPORT_ERRORS_KEPT,
  STANDARD_UNITS,
  type Locale,
  type StandardUnit,
} from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import { appCodeOf, type DemoApi } from './client'
import type {
  DemoCategory,
  DemoCosting,
  DemoCustomerPayment,
  DemoExpense,
  DemoImport,
  DemoMaterial,
  DemoOrder,
  DemoPack,
  DemoPayment,
  DemoProduct,
  DemoPurchase,
  DemoReturn,
  DemoSale,
  DemoStatement,
  UnitOrPack,
} from './costing-data'
import { addDays, dayOf, daysBetween, lastMonthOf, monthStart, type DemoDay } from './days'
import { amountOfFils, filsOf, percentOf, readSalesFile, salesFile, TIPS_NAME } from './files'

// The data part of `pnpm demo:seed` (docs/ARCHITECTURE.md §Local setup › Demo data): each demo
// business's suppliers, materials, products & services, recipes, purchases (posted, so the stock
// ledger, the averages and the audit log are real), returns and credit notes, payments, running costs,
// expenses and the owner's time, and its sales (M3, Release A): channels, Today's sales and One sale,
// sales files imported and app statements, customers, orders with deposits, deliveries, payments and
// refunds. Entered through the API as its owner (and as a member where a member would enter it), only
// in the modules the business has on.
//
// Idempotent: every record's id is derived from the business and the record's key, and each is read
// before it is written, so a second run adds nothing and a run cut short is completed by the next one.
// Documents are dated back from the business's today (demo/days.ts) and entered in date order (as if
// on the day); nothing is dated in the future and the books are never closed. A record that cannot be
// written (the owner changed the business since) is reported and skipped; the rest goes on.
//
// On a day: purchases, expenses, returns, payments, then sales (each finalized as the member who
// entered it, so its cost is frozen from the purchases posted by then, D-222) and sales files (the day
// after their last day: last month's on this month's 1st, this month's on the seed day), then orders
// (entered with their deposit, delivered after the day's sales, or cancelled), the customers' payments,
// refunds, and last the apps' statements of the files' days.

type Envelope<T> = WithMeta<T>

export interface CostingSummary {
  business: string
  materials: string
  products: string
  purchases: string
  runningCosts: string
  expenses: string
  sales: string
  imports: string
  orders: string
}

export interface CostingResult {
  summary: CostingSummary
  /** What was skipped and why. */
  notes: string[]
  /** Records that could not be written. */
  warnings: string[]
  /** How many of its names each file imported now needed an answer for (the others matched). */
  answered: Map<string, number>
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
  /** A token for a demo member of the business (who enters an expense, a sale, a file…). */
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

const isStandardUnit = (value: string): value is StandardUnit => value in STANDARD_UNITS

const VAT_RATE = '5'

/** A document entered on its day, in this order on the same day (see above). */
interface TimelineEvent {
  order: number
  daysAgo: number
  label: string
  run: () => Promise<void>
}

const ORDER = {
  purchase: 0,
  expense: 1,
  return: 2,
  payment: 3,
  sale: 4,
  import: 5,
  order: 6,
  delivery: 7,
  customerPayment: 8,
  refund: 9,
  statement: 10,
} as const

class CostingSeed {
  private readonly notes: string[] = []
  private readonly warnings: string[] = []
  private readonly answered = new Map<string, number>()
  private modules = new Set<string>()
  private capabilities: Record<string, boolean> = {}
  private today = ''
  private readonly materials = new Map<string, Pick<DemoMaterial, 'key' | 'packs'>>()
  private readonly products = new Map<string, DemoProduct>()
  private members = new Map<string, string>()
  private locations = new Map<string, string>()
  private categories = new Map<string, string>()
  /** The business's channels: a demo channel's key → id, and a starter channel's kind → id. */
  private channelIds = new Map<string, string>()
  /** A sale that names no channel: the business's first starter channel, never one the demo adds. */
  private starterChannelId: string | null = null

  constructor(
    private readonly ctx: CostingContext,
    private readonly data: DemoCosting,
  ) {
    for (const material of data.materials ?? []) this.materials.set(material.key, material)
    for (const product of data.products ?? []) {
      this.products.set(product.key, product)
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

  /** The token of the member who enters a record (default: the owner). */
  private tokenFor(email: string | undefined): Promise<string> {
    return email ? this.ctx.tokenOf(email) : Promise.resolve(this.ctx.token)
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

  /** The day a record is dated (never after today). */
  private dayOf(when: DemoDay): string {
    return dayOf(when, this.today)
  }

  /** How many days before today a day is. */
  private ago(day: string): number {
    return daysBetween(day, this.today)
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

  private locationId(branch: string | undefined): string | null {
    if (!branch) return null
    const id = this.locations.get(branch)
    if (!id) throw new Error(`no location "${branch}"`)
    return id
  }

  private channelId(key: string | undefined): string {
    const id = key ? this.channelIds.get(key) : this.starterChannelId
    if (!id) throw new Error(`no channel "${key ?? 'starter'}"`)
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

  /** The owner's time can be saved: the business works without a team (D-119). */
  private ownerTimeAvailable(): boolean {
    return this.active('cost_engine') && this.capabilities.has_team !== true
  }

  private async productsStep(): Promise<void> {
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
  // Purchasing and spending, in date order
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
      doc = (
        await this.mutate<Envelope<PurchaseDto>>('purchase.create', {
          id,
          supplierId: this.supplierId(p.supplier),
          businessDate: this.dayOf(p.daysAgo),
          documentType: document,
          reference: p.reference ?? null,
          paymentMethod: p.payment,
          paidByMemberId: null,
          pricesIncludeVat,
          locationId: this.locationId(p.branch),
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
          businessDate: this.dayOf(r.daysAgo),
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
      businessDate: this.dayOf(pay.daysAgo),
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
      await this.mutate(
        'expense.create',
        {
          id,
          categoryId: await this.categoryId(e.category),
          supplierId: this.supplierId(e.supplier),
          businessDate: this.dayOf(e.daysAgo),
          documentType: document,
          reference: e.reference ?? null,
          description: e.description,
          paymentMethod: e.payment,
          paidByMemberId: this.memberId(e.paidBy),
          pricesIncludeVat,
          locationId: null,
          amount: e.amount,
          vatRate,
          ...(e.monthsBack === undefined
            ? {}
            : { periodMonth: monthStart(this.today, -e.monthsBack).slice(0, 7) }),
        },
        await this.tokenFor(e.enteredBy),
      )
      doc = (await this.query<Envelope<ExpenseDto>>('expense.get', { id })).data
    }
    if (e.approval) {
      // Who entered it sends it for approval (approval turned on first), once: a draft only.
      if (doc.status === 'draft') {
        await this.requireApproval()
        doc = (
          await this.mutate<Envelope<ExpenseDto>>(
            'expense.submit',
            { id, version: doc.version },
            await this.tokenFor(e.enteredBy),
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
    // The owner finalizes it (with approval on, the owner's finalizing approves it too, D-164),
    // saying what it pays in a category that has running costs (D-216).
    if (['draft', 'submitted', 'approved'].includes(doc.status)) {
      await this.mutate('expense.post', { id, version: doc.version, ...this.paysOf(e) })
    }
  }

  /**
   * What an expense pays (D-216), as the owner says it when he finalizes it: only while Running Costs
   * is on (otherwise nothing is asked, and the running costs were not entered).
   */
  private paysOf(e: DemoExpense): { pays?: object } {
    if (e.pays === undefined) return {}
    // A channel's app fees (M3 Step 3, Q8): in any category, while Sales is on.
    if (typeof e.pays === 'object' && 'channelFees' in e.pays) {
      const channelId = this.channelIds.get(e.pays.channelFees)
      return this.active('sales') && channelId ? { pays: { kind: 'channel_fees', channelId } } : {}
    }
    if (!this.active('running_costs')) return {}
    return e.pays === 'extra'
      ? { pays: { kind: 'extra' } }
      : {
          pays: {
            kind: 'running_cost',
            runningCostId: this.id(`running-cost:${e.pays.runningCost}`),
          },
        }
  }

  /** Expenses need approval (D-164): turned on when an expense is first sent for it. */
  private async requireApproval(): Promise<void> {
    const settings = await this.query<ExpenseSettingsDto>('expense.settings')
    if (!settings.approvalRequired) await this.mutate('expense.updateSettings', { approval: true })
  }

  private async documents(): Promise<void> {
    const events: TimelineEvent[] = []
    const at = (order: number, day: string, label: string, run: () => Promise<void>) =>
      events.push({ order, daysAgo: this.ago(day), label, run })
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
        at(ORDER.purchase, this.dayOf(p.daysAgo), `purchase ${p.key}`, () => this.purchase(p))
      }
      for (const r of returns) {
        at(ORDER.return, this.dayOf(r.daysAgo), `${r.kind} ${r.key}`, () => this.purchaseReturn(r))
      }
    }
    if (spending) {
      for (const e of expenses) {
        at(ORDER.expense, this.dayOf(e.daysAgo), `expense ${e.key}`, () => this.expense(e))
      }
    }
    for (const pay of payments) {
      if ((pay.purchase && !purchasing) || (pay.expense && !spending)) continue
      at(ORDER.payment, this.dayOf(pay.daysAgo), `payment ${pay.key}`, () => this.payment(pay))
    }
    events.push(...this.saleEvents(), ...this.importEvents(), ...this.orderEvents())
    events.sort((a, b) => b.daysAgo - a.daysAgo || a.order - b.order)
    for (const event of events) await this.attempt(event.label, event.run)
  }

  // -------------------------------------------------------------------------------------------------
  // Sales (M3 Step 2) and what customers pay for them (Step 5)
  // -------------------------------------------------------------------------------------------------

  /** The channels the business adds (with their commission, seen and set by the owner). */
  private async channels(): Promise<void> {
    const channels = this.data.channels ?? []
    const sales = this.data.sales ?? []
    const imports = this.data.imports ?? []
    const count = channels.length + sales.length + imports.length
    if (this.skipUnless('sales channels and sales', count, 'sales')) return
    const listed = async () =>
      (await this.query<Envelope<{ items: SalesChannelDto[] }>>('channel.list', { status: 'all' }))
        .data.items
    let existing = await listed()
    for (const c of channels) {
      await this.attempt(`channel ${c.key}`, async () => {
        const id = this.id(`channel:${c.key}`)
        if (existing.some((e) => e.id === id)) return
        await this.mutate('channel.create', {
          id,
          name: c.name,
          kind: c.kind,
          feePercent: c.feePercent ?? null,
        })
      })
    }
    existing = await listed()
    for (const c of channels) this.channelIds.set(c.key, this.id(`channel:${c.key}`))
    // The starter channels (by kind), the first of each. A sale naming no channel goes to the first
    // of them, never to a marketplace or app the demo adds (its commission would be charged).
    const added = new Set(channels.map((c) => this.id(`channel:${c.key}`)))
    for (const e of existing) {
      if (e.archivedAt !== null || added.has(e.id)) continue
      this.starterChannelId ??= e.id
      if (!this.channelIds.has(e.kind)) this.channelIds.set(e.kind, e.id)
    }
  }

  /**
   * The days of a sheet that covers several days (`covers`), or null for a sale of one day; null too
   * for this month's on its 1st (no day before today in it).
   */
  private sheetDays(sale: DemoSale): { from: string; to: string } | null {
    if (sale.covers === 'month_before') {
      return { from: monthStart(this.today, -2), to: addDays(monthStart(this.today, -1), -1) }
    }
    if (sale.covers === 'last_month') return lastMonthOf(this.today)
    if (sale.covers === 'this_month') {
      const from = monthStart(this.today, 0)
      const to = addDays(this.today, -1)
      return to < from ? null : { from, to }
    }
    return null
  }

  /** A sheet of this month so far counts its month's quantities for its days (at least 1). */
  private qtyOf(sale: DemoSale, qty: string): string {
    const days = sale.covers === 'this_month' ? this.sheetDays(sale) : null
    if (!days) return qty
    const covered = daysBetween(days.from, days.to) + 1
    return String(Math.max(1, Math.round((Number(qty) * covered) / 30)))
  }

  private saleEvents(): TimelineEvent[] {
    const sales = this.data.sales ?? []
    if (this.skipUnless('sales', sales.length, 'sales', 'products')) return []
    return sales.flatMap((sale): TimelineEvent[] => {
      if (sale.covers === 'this_month' && !this.sheetDays(sale)) return []
      const day = this.saleDay(sale)
      return [
        {
          order: ORDER.sale,
          daysAgo: this.ago(day),
          label: `sale ${sale.key}`,
          run: () => this.sale(sale),
        },
        ...(sale.payments ?? []).map((pay) => {
          const daysAgo = this.ago(this.notBefore(this.dayOf(pay.daysAgo), day))
          return {
            order: ORDER.customerPayment,
            daysAgo,
            label: `sale ${sale.key}: payment ${pay.key}`,
            run: () =>
              this.customerPayment({ saleId: this.id(`sale:${sale.key}`) }, sale.key, {
                ...pay,
                daysAgo,
              }),
          }
        }),
      ]
    })
  }

  /** The day a sale is dated: a sheet of several days on its last day, else its own. */
  private saleDay(sale: DemoSale): string {
    return this.sheetDays(sale)?.to ?? this.dayOf(sale.daysAgo)
  }

  /** `day`, or `after` when `day` is before it (a step never comes before the one it follows). */
  private notBefore(day: string, after: string): string {
    return day < after ? after : day
  }

  private async sale(sale: DemoSale): Promise<void> {
    const id = this.id(`sale:${sale.key}`)
    const token = await this.tokenFor(sale.enteredBy)
    let doc = (await this.find<Envelope<SaleDto>>('sale.get', { id }))?.data
    if (!doc) {
      const days = this.sheetDays(sale)
      const customer = sale.customer && this.active('customers') ? sale.customer : undefined
      doc = (
        await this.mutate<Envelope<SaleDto>>(
          'sale.create',
          {
            id,
            source: sale.source,
            businessDate: this.saleDay(sale),
            periodFrom: days && days.from !== days.to ? days.from : null,
            locationId: this.locationId(sale.branch),
            channelId: this.channelId(sale.channel),
            deliveryNeeded: sale.delivery !== undefined,
            deliveryArea: sale.delivery?.area ?? null,
            ...(sale.delivery?.cost ? { deliveryCost: sale.delivery.cost } : {}),
            customerId: customer ? this.id(`customer:${customer}`) : null,
            payLater: customer !== undefined && sale.payLater === true && this.active('payments'),
            lines: [
              ...sale.lines.map(([product, qty, price]) => ({
                kind: 'item',
                id: this.id(`sale:${sale.key}:line:${product}`),
                productId: this.id(`product:${product}`),
                qty: this.qtyOf(sale, qty),
                unitPrice: price ?? this.products.get(product)?.price ?? '0',
              })),
              ...(sale.delivery
                ? [
                    {
                      kind: 'delivery',
                      id: this.id(`sale:${sale.key}:delivery`),
                      amount: sale.delivery.charged,
                    },
                  ]
                : []),
            ],
          },
          token,
        )
      ).data
    }
    if (!sale.draft && doc.status === 'draft') {
      await this.mutate('sale.post', { id, version: doc.version }, token)
    }
  }

  /** A customer's payment on an order or a sale "they'll pay later" (or money given back). */
  private async customerPayment(
    document: { orderId: string } | { saleId: string },
    key: string,
    pay: DemoCustomerPayment,
  ): Promise<void> {
    if (!this.active('payments')) return
    const id = this.id(`${'orderId' in document ? 'order' : 'sale'}:${key}:payment:${pay.key}`)
    const listed = await this.query<CustomerPaymentListDto>('customerPayment.list', document)
    if (listed.items.some((p) => p.id === id)) return
    const amount = pay.amount === 'outstanding' ? (listed.document?.owed ?? '0') : pay.amount
    if (compareDecimal(amount, '0') <= 0) return
    await this.mutate('customerPayment.record', {
      id,
      ...document,
      kind: pay.kind ?? 'payment',
      businessDate: this.dayOf(pay.daysAgo),
      method: pay.method,
      amount,
    })
  }

  // -------------------------------------------------------------------------------------------------
  // Sales files and the apps' statements (M3 Step 4)
  // -------------------------------------------------------------------------------------------------

  private importEvents(): TimelineEvent[] {
    const imports = this.data.imports ?? []
    const statements = this.data.statements ?? []
    const what = 'sales files and statements'
    if (this.skipUnless(what, imports.length + statements.length, 'sales', 'products')) return []
    const events: TimelineEvent[] = []
    for (const imp of imports) {
      const file = salesFile(imp, this.products, this.today)
      if (!file) continue
      // Imported the day after its last day (this month's, on the seed day).
      const last = file.rows.reduce((max, row) => (row.day > max ? row.day : max), '')
      const day = last < this.today ? addDays(last, 1) : this.today
      events.push({
        order: ORDER.import,
        daysAgo: this.ago(day),
        label: `import ${imp.key}`,
        run: () => this.importFile(imp),
      })
    }
    // Last month's statements come once its files are in.
    const firstOfMonth = monthStart(this.today, 0)
    for (const statement of statements) {
      events.push({
        order: ORDER.statement,
        daysAgo: this.ago(firstOfMonth),
        label: `statement ${statement.key}`,
        run: () => this.statement(statement),
      })
    }
    return events
  }

  /**
   * A file imported as the import screen sends it (the draft, then its rows in chunks), its names
   * answered as the owner would (the product it is, by item code when the file has codes; tips "not
   * something I sell"), then finalized.
   */
  private async importFile(imp: DemoImport): Promise<void> {
    const id = this.id(`import:${imp.key}`)
    const token = await this.tokenFor(imp.enteredBy)
    let doc = (await this.find<Envelope<SaleImportDto>>('saleImport.get', { id }))?.data
    if (!doc) {
      const file = salesFile(imp, this.products, this.today)
      if (!file) return
      const { headerRow, mapping, dateOrder, read, fileHash, fingerprint } = readSalesFile(
        file,
        this.vatRegistered,
      )
      if (read.problem !== null || read.period === null || read.rowsLeftOut > 0) {
        throw new Error(`demo data: ${file.name} reads with ${read.problem ?? 'rows left out'}`)
      }
      const headers: Record<string, string> = {}
      for (const [field, column] of Object.entries(mapping)) {
        headers[field] = String(file.cells[headerRow]?.[column] ?? '')
      }
      await this.mutate(
        'saleImport.create',
        {
          id,
          channelId: this.channelId(imp.channel),
          locationId: this.locationId(imp.branch),
          fileName: file.name,
          fileHash,
          fingerprint,
          shape: read.shape,
          periodFrom: read.period.from,
          periodTo: read.period.to,
          mapping: { headerRow, columns: { ...mapping }, headers, dateOrder },
          amountsIncludeVat: read.amountsIncludeVat,
          rowsRead: read.rowsRead,
          rowsLeftOut: read.rowsLeftOut,
          errors: read.errors.slice(0, IMPORT_ERRORS_KEPT),
          feesTotal: read.fees,
          rowCount: read.items.length,
        },
        token,
      )
      const rows = read.items.map((item, position) => ({
        position,
        businessDate: item.day,
        name: item.name,
        code: item.code,
        qty: item.qty,
        amount: item.amount,
        refunds: item.refunds,
        fileRows: item.rows,
      }))
      for (let start = 0; start < rows.length; start += IMPORT_ROWS_CHUNK) {
        await this.mutate(
          'saleImport.addRows',
          { id, rows: rows.slice(start, start + IMPORT_ROWS_CHUNK) },
          token,
        )
      }
      doc = (await this.query<Envelope<SaleImportDto>>('saleImport.get', { id })).data
    }
    if (doc.status !== 'draft') return
    type Answer = { name: string; code: string | null; target: string; productId: string | null }
    const answers = doc.names.flatMap((entry): Answer[] => {
      if (entry.match.state !== 'unmatched') return []
      if (entry.name === TIPS_NAME) {
        return [{ name: entry.name, code: entry.code, target: 'skip', productId: null }]
      }
      const item = imp.items.find((i) =>
        entry.code !== null
          ? i.code === entry.code
          : (i.name ?? this.products.get(i.product)?.name) === entry.name,
      )
      if (!item) throw new Error(`demo data: ${imp.key} has no answer for "${entry.name}"`)
      return [
        {
          name: entry.name,
          code: entry.code,
          target: 'product',
          productId: this.id(`product:${item.product}`),
        },
      ]
    })
    this.answered.set(imp.key, answers.length)
    if (answers.length > 0) {
      doc = (await this.mutate<Envelope<SaleImportDto>>('saleImport.match', { id, answers }, token))
        .data
    }
    await this.mutate('saleImport.post', { id, version: doc.version }, token)
  }

  /**
   * A channel's statement for days of last month, typed from the app's statement: the sales it lists
   * are what the channel's files of last month add up to on those days (as the customers paid), and
   * the app kept its commission and payment fees (a % of them) and its ads.
   */
  private async statement(s: DemoStatement): Promise<void> {
    const id = this.id(`statement:${s.key}`)
    const channelId = this.channelId(s.channel)
    const listed = await this.query<ChannelStatementListDto>('channelStatement.list', {
      channelId,
    })
    let doc = listed.data.items.find((item) => item.id === id)
    if (!doc) {
      const { from: first, to: lastDay } = lastMonthOf(this.today)
      const dayOfMonth = (n: number) =>
        `${first.slice(0, 8)}${String(Math.min(n, Number(lastDay.slice(8, 10)))).padStart(2, '0')}`
      const from = dayOfMonth(s.days[0])
      const to = dayOfMonth(s.days[1])
      let sales = 0n
      for (const imp of this.data.imports ?? []) {
        if (imp.channel !== s.channel || imp.month !== 'last') continue
        for (const row of salesFile(imp, this.products, this.today)?.rows ?? []) {
          if (row.day >= from && row.day <= to) sales += row.amount
        }
      }
      if (sales === 0n) throw new Error(`demo data: ${s.key} lists no sales`)
      const commission = percentOf(sales, s.commissionPercent)
      const paymentFees = percentOf(sales, s.paymentFeesPercent ?? '0')
      const ads = filsOf(s.ads ?? '0')
      doc = (
        await this.mutate<ChannelStatementResultDto>('channelStatement.create', {
          id,
          channelId,
          periodFrom: from,
          periodTo: to,
          sales: amountOfFils(sales),
          commission: amountOfFils(commission),
          paymentFees: amountOfFils(paymentFees),
          otherFees: '0',
          ads: amountOfFils(ads),
          refundsCharged: '0',
          payout: amountOfFils(sales - commission - paymentFees - ads),
          notes: s.notes ?? null,
        })
      ).data
    }
    if (doc.status === 'draft') {
      await this.mutate('channelStatement.post', { id, version: doc.version })
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Customers and orders (M3 Step 5)
  // -------------------------------------------------------------------------------------------------

  private async customers(): Promise<void> {
    const customers = this.data.customers ?? []
    if (this.skipUnless('customers', customers.length, 'customers')) return
    for (const c of customers) {
      await this.attempt(`customer ${c.key}`, async () => {
        const id = this.id(`customer:${c.key}`)
        if (await this.find<CustomerDto>('customer.get', { id })) return
        await this.mutate('customer.create', {
          id,
          name: c.name,
          kind: c.kind ?? 'individual',
          phone: c.phone ?? null,
          email: c.email ?? null,
          trn: this.vatRegistered ? (c.trn ?? null) : null,
          tradeLicenceNo: c.tradeLicenceNo ?? null,
          emirate: c.emirate ?? null,
        })
      })
    }
  }

  /**
   * Each order's steps on their days, after the day's sales: entered with its deposit, delivered or
   * cancelled, then its payments, then its refund (each never before the step it follows).
   */
  private orderEvents(): TimelineEvent[] {
    const orders = this.data.orders ?? []
    const what = 'orders, their payments and refunds'
    if (this.skipUnless(what, orders.length, 'orders', 'customers', 'payments', 'products')) {
      return []
    }
    return orders.flatMap((o): TimelineEvent[] => {
      const entered = this.dayOf(o.daysAgo)
      const done =
        o.deliveredDaysAgo !== undefined
          ? this.notBefore(this.dayOf(o.deliveredDaysAgo), entered)
          : o.cancelledDaysAgo !== undefined
            ? this.notBefore(this.dayOf(o.cancelledDaysAgo), entered)
            : entered
      const event = (order: number, day: string, label: string, run: () => Promise<void>) => ({
        order,
        daysAgo: this.ago(day),
        label: `order ${o.key}${label}`,
        run,
      })
      return [
        event(ORDER.order, entered, '', () => this.newOrder(o)),
        ...(o.deliveredDaysAgo === undefined
          ? []
          : [event(ORDER.delivery, done, ': delivery', () => this.deliverOrder(o, done))]),
        ...(o.cancelledDaysAgo === undefined
          ? []
          : [event(ORDER.delivery, done, ': cancel', () => this.cancelOrder(o))]),
        ...(o.payments ?? []).map((pay) => {
          const day = this.notBefore(this.dayOf(pay.daysAgo), done)
          return event(ORDER.customerPayment, day, `: payment ${pay.key}`, () =>
            this.customerPayment({ orderId: this.orderId(o) }, o.key, {
              ...pay,
              daysAgo: this.ago(day),
            }),
          )
        }),
        ...(o.refund
          ? [
              event(
                ORDER.refund,
                this.notBefore(this.dayOf(o.refund.daysAgo), done),
                `: refund ${o.refund.key}`,
                () => this.orderRefund(o, this.notBefore(this.dayOf(o.refund!.daysAgo), done)),
              ),
            ]
          : []),
      ]
    })
  }

  private orderId(o: DemoOrder): string {
    return this.id(`order:${o.key}`)
  }

  private async orderOf(o: DemoOrder): Promise<OrderDto | undefined> {
    return (await this.find<Envelope<OrderDto>>('order.get', { id: this.orderId(o) }))?.data
  }

  private async newOrder(o: DemoOrder): Promise<void> {
    if (await this.orderOf(o)) return
    const day = this.dayOf(o.daysAgo)
    const channelId = this.channelIds.get('messages') ?? [...this.channelIds.values()][0] ?? null
    await this.mutate(
      'order.create',
      {
        id: this.orderId(o),
        businessDate: day,
        dueDate: o.dueIn === undefined ? null : addDays(day, o.dueIn),
        customerId: this.id(`customer:${o.customer}`),
        customerRef: o.customerRef ?? null,
        channelId,
        deliveryNeeded: o.delivery !== undefined,
        deliveryArea: o.delivery?.area ?? null,
        ...(o.delivery?.cost ? { deliveryCost: o.delivery.cost } : {}),
        lines: [
          ...o.lines.map(([product, qty, price]) => ({
            kind: 'item',
            id: this.id(`order:${o.key}:line:${product}`),
            productId: this.id(`product:${product}`),
            qty,
            unitPrice: price ?? this.products.get(product)?.price ?? '0',
          })),
          ...(o.delivery?.charged
            ? [
                {
                  kind: 'delivery',
                  id: this.id(`order:${o.key}:delivery`),
                  amount: o.delivery.charged,
                },
              ]
            : []),
        ],
        payment: o.deposit
          ? {
              id: this.id(`order:${o.key}:deposit`),
              method: o.deposit.method,
              amount: o.deposit.amount,
            }
          : null,
      },
      await this.tokenFor(o.enteredBy),
    )
  }

  private async deliverOrder(o: DemoOrder, day: string): Promise<void> {
    const order = await this.orderOf(o)
    if (!order) throw new Error('the order was not entered')
    if (order.status !== 'pending') return
    await this.mutate(
      'order.deliver',
      { id: order.id, version: order.version, businessDate: day },
      await this.tokenFor(o.enteredBy),
    )
  }

  private async cancelOrder(o: DemoOrder): Promise<void> {
    const order = await this.orderOf(o)
    if (!order) throw new Error('the order was not entered')
    if (order.status !== 'pending') return
    await this.mutate('order.cancel', { id: order.id, version: order.version })
  }

  private async orderRefund(o: DemoOrder, day: string): Promise<void> {
    const refund = o.refund
    if (!refund) return
    const id = this.id(`order:${o.key}:refund:${refund.key}`)
    const order = await this.orderOf(o)
    if (!order?.saleId) throw new Error('the order was not delivered')
    if (!(await this.find<Envelope<SaleDto>>('sale.get', { id }))) {
      const sale = (await this.query<Envelope<SaleDto>>('sale.get', { id: order.saleId })).data
      const productId = this.id(`product:${refund.product}`)
      const line = sale.lines.find((l) => l.kind === 'item' && l.productId === productId)
      if (!line) throw new Error(`the order has no ${refund.product}`)
      await this.mutate('sale.refund', {
        id,
        orderId: order.id,
        by: refund.by,
        businessDate: day,
        lines: [
          refund.by === 'amount'
            ? { lineId: line.id, amount: refund.value }
            : { lineId: line.id, qty: refund.value },
        ],
        notes: refund.notes ?? null,
      })
    }
    if (!refund.payBack) return
    // The money given back with it: what the customer then paid beyond what the order comes to.
    const backId = this.id(`order:${o.key}:refund:${refund.key}:back`)
    const listed = await this.query<CustomerPaymentListDto>('customerPayment.list', {
      orderId: order.id,
    })
    if (listed.items.some((p) => p.id === backId)) return
    const overpaid = (await this.orderOf(o))?.payment?.overpaid ?? '0'
    if (compareDecimal(overpaid, '0') <= 0) return
    await this.mutate('customerPayment.record', {
      id: backId,
      orderId: order.id,
      kind: 'refund',
      businessDate: day,
      method: refund.payBack,
      amount: overpaid,
    })
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

  /**
   * The owner's hourly rate, without a team (D-119): set before any sale, so each sale's time is
   * costed when it is finalized (a rate set later fills them once).
   */
  private async ownerTime(): Promise<void> {
    const rate = this.data.ownerHourlyRate
    if (!rate) return
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
      sales: await counted('sales', 'sale.list', { status: 'posted' }, false),
      imports: await counted('sales', 'saleImport.list', { status: 'posted' }, false),
      orders: await counted('orders', 'order.list', {}, false),
    }
  }

  async run(): Promise<CostingResult> {
    await this.load()
    await this.loadCategories()
    await this.suppliers()
    await this.materialsStep()
    await this.productsStep()
    await this.recipes()
    await this.runningCosts()
    await this.ownerTime()
    await this.channels()
    await this.customers()
    await this.documents()
    return {
      summary: await this.summary(),
      notes: this.notes,
      warnings: this.warnings,
      answered: this.answered,
    }
  }
}

/** Adds the business's data (what is missing of it) through the API. */
export function seedCosting(ctx: CostingContext, data: DemoCosting): Promise<CostingResult> {
  return new CostingSeed(ctx, data).run()
}
