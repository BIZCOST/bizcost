import type {
  BooksDto,
  BusinessProfileDto,
  MaterialCostsDto,
  MaterialDto,
  PurchaseDto,
  PurchaseReturnDto,
  SupplierDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId, replayWac, type WacMovement } from '@bizcost/domain'
import type { RoleTemplateKey, SetupAnswers } from '@bizcost/modules'
import { expect } from 'vitest'
import { appRouter } from '../src'
import {
  connectAdmin,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  SECRET_KEY,
  mutate,
  query,
  type Admin,
  type CallResult,
  type TestUser,
} from './helpers'
import { join, setupBusiness, WORKSHOP } from './settings'

// Helpers of the purchasing tests (ROADMAP.md M2 Step 3): the API as released code has it (the
// Costing Core is released since M2 Step 7: no dev-only preview), people and businesses made the real
// way, materials, suppliers, purchases and returns through the API, and the database read as postgres
// to compare the ledger with its projections.

export type Handler = ReturnType<typeof handlerFor>

export interface Person {
  user: TestUser
  token: string
}

const procedures = appRouter._def.procedures as unknown as Record<
  string,
  { _def: { type: string } }
>

export class PurchasingApi {
  readonly db: Db = connectApi()
  readonly admin: Admin = connectAdmin()
  /** The API as deployed (the secret key for Storage: receipts). */
  readonly handler: Handler = handlerFor(this.db, undefined, { supabaseSecretKey: SECRET_KEY })
  private readonly users: TestUser[] = []

  async person(): Promise<Person> {
    const user = await createUser({ locale: 'en' })
    this.users.push(user)
    return { user, token: await mintToken(user) }
  }

  /** A business made by Smart Setup, with its owner. */
  async business(
    answers: SetupAnswers = WORKSHOP,
    name = `Purchases ${newId().slice(-8)}`,
  ): Promise<{ id: string; owner: Person }> {
    const owner = await this.person()
    const id = await setupBusiness(this.handler, owner.token, answers, { name })
    return { id, owner }
  }

  /** A member of the business holding its `template` role. */
  async member(
    business: { id: string; owner: Person },
    template: RoleTemplateKey,
  ): Promise<Person & { memberId: string }> {
    const person = await this.person()
    const memberId = await join(this.db, business.owner.user, business.id, person.user, template)
    return { ...person, memberId }
  }

  call<T>(
    person: Person,
    businessId: string,
    path: string,
    input?: unknown,
    handler: Handler = this.handler,
  ): Promise<CallResult<T>> {
    const run = procedures[path]?._def.type === 'query' ? query<T> : mutate<T>
    return run(handler, path, { token: person.token, businessId, input })
  }

  async close() {
    for (const user of this.users) await deleteUser(user)
    await this.admin.end()
    await this.db.$client.end()
  }
}

export function ok<T>(result: CallResult<T>): T {
  expect(result.error, result.raw).toBeUndefined()
  return result.data as T
}

export function codeOf(result: CallResult): string | undefined {
  return result.error?.data.appCode
}

/** The owner's milk: counted in litres, 1 carton = 12 bottles of 1 L. */
export function milkInput(name = `Milk ${newId().slice(-8)}`) {
  const bottle = newId()
  const carton = newId()
  return {
    input: {
      id: newId(),
      name,
      unit: 'l',
      packs: [
        { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
        { id: carton, name: 'carton', qty: '12', ofPackId: bottle },
      ],
    },
    bottle,
    carton,
  }
}

/** A material line in a standard unit. */
export function line(materialId: string, qty: string, unitPrice: string, extra: object = {}) {
  return { kind: 'material', id: newId(), materialId, qty, unit: 'l', unitPrice, ...extra }
}

/** A purchase's input (a no-invoice purchase paid in cash, dated `date`, unless given). */
export function purchaseInput(date: string, lines: object[], extra: object = {}) {
  return {
    id: newId(),
    businessDate: date,
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    lines,
    ...extra,
  }
}

/** One scope: a business, its owner and a way to call as them. */
export class Scope {
  constructor(
    readonly api: PurchasingApi,
    readonly id: string,
    readonly owner: Person,
  ) {}

  static async open(api: PurchasingApi, answers?: SetupAnswers): Promise<Scope> {
    const { id, owner } = await api.business(answers)
    return new Scope(api, id, owner)
  }

  as<T>(person: Person, path: string, input?: unknown) {
    return this.api.call<T>(person, this.id, path, input)
  }

  run<T>(path: string, input?: unknown) {
    return this.api.call<T>(this.owner, this.id, path, input)
  }

  async today(): Promise<string> {
    return ok(await this.run<BooksDto>('books.get')).today
  }

  /** The business is no longer VAT-registered (Settings → Business profile, as the owner). */
  async deregisterVat(): Promise<void> {
    const profile = ok(await this.run<BusinessProfileDto>('business.profile'))
    ok(
      await this.run('business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: profile.legalNameAr,
        vatRegistered: false,
        trn: null,
      }),
    )
  }

  async material(input = milkInput().input): Promise<MaterialDto> {
    return ok(await this.run<MaterialDto>('material.create', input))
  }

  async supplier(name = `Dairy ${newId().slice(-8)}`): Promise<SupplierDto> {
    return ok(await this.run<SupplierDto>('supplier.create', { id: newId(), name }))
  }

  /** Creates a draft purchase (the envelope's data). */
  async draft(input: object): Promise<PurchaseDto> {
    return ok(await this.run<{ data: PurchaseDto }>('purchase.create', input)).data
  }

  async post(purchase: PurchaseDto): Promise<PurchaseDto> {
    return ok(
      await this.run<{ data: PurchaseDto }>('purchase.post', {
        id: purchase.id,
        version: purchase.version,
      }),
    ).data
  }

  /** A posted purchase. */
  async buy(input: object): Promise<PurchaseDto> {
    return this.post(await this.draft(input))
  }

  async reverse(id: string): Promise<PurchaseDto> {
    return ok(await this.run<{ data: PurchaseDto }>('purchase.reverse', { id })).data
  }

  async returnDraft(input: object): Promise<PurchaseReturnDto> {
    return ok(await this.run<{ data: PurchaseReturnDto }>('purchaseReturn.create', input)).data
  }

  async postReturn(document: PurchaseReturnDto): Promise<PurchaseReturnDto> {
    return ok(
      await this.run<{ data: PurchaseReturnDto }>('purchaseReturn.post', {
        id: document.id,
        version: document.version,
      }),
    ).data
  }

  async costs(ids: string[]) {
    return ok(await this.run<MaterialCostsDto>('material.costs', { ids })).data.items
  }

  /** The material's cost row (the projection), read as postgres. */
  async costRow(materialId: string) {
    const [row] = await this.api.admin<{ qty: string; value: string; avg_cost: string | null }[]>`
      select trim_scale(qty)::text as qty, trim_scale(value)::text as value,
             trim_scale(avg_cost)::text as avg_cost
        from app.material_costs where business_id = ${this.id} and material_id = ${materialId}`
    return row
  }

  /** Every movement of the material, in posting order, as the WAC engine reads them. */
  async ledger(materialId: string): Promise<WacMovement[]> {
    const rows = await this.api.admin<
      {
        id: string
        kind: string
        qty: string
        value: string
        receipt_id: string | null
        reverses_id: string | null
        reverses_kind: string | null
      }[]
    >`
      select m.id, m.kind, trim_scale(m.qty)::text as qty, trim_scale(m.value)::text as value,
             m.receipt_id, m.reverses_id, r.kind as reverses_kind
        from app.stock_movements m
        left join app.stock_movements r on r.id = m.reverses_id
       where m.business_id = ${this.id} and m.material_id = ${materialId}
       order by m.seq`
    const neg = (v: string) => (v.startsWith('-') ? v.slice(1) : v === '0' ? '0' : `-${v}`)
    return rows.map((r): WacMovement => {
      if (r.kind === 'purchase')
        return { type: 'receipt', id: r.id, qty: r.qty, value: r.value } as WacMovement
      if (r.kind === 'purchase_return') {
        return {
          type: 'return',
          id: r.id,
          receiptId: r.receipt_id!,
          qty: neg(r.qty),
          value: neg(r.value),
        } as WacMovement
      }
      if (r.kind === 'purchase_credit') {
        return {
          type: 'credit',
          id: r.id,
          receiptId: r.receipt_id!,
          amount: neg(r.value),
        } as WacMovement
      }
      if (r.reverses_kind === 'purchase')
        return { type: 'receipt_reversal', receiptId: r.reverses_id! }
      if (r.reverses_kind === 'purchase_return')
        return { type: 'return_reversal', returnId: r.reverses_id! }
      return { type: 'credit_reversal', creditId: r.reverses_id! }
    })
  }

  /** The rebuild from the ledger equals the projections (D-110 rule 2). */
  async expectRebuildEqualsProjections() {
    const materials = await this.api.admin<{ material_id: string }[]>`
      select distinct material_id from app.stock_movements where business_id = ${this.id}`
    for (const { material_id } of materials) {
      const { state } = replayWac(await this.ledger(material_id))
      expect(await this.costRow(material_id), material_id).toEqual({
        qty: state.qty,
        value: state.value,
        avg_cost: state.avgCost,
      })
    }
    const balances = await this.api.admin<
      { location_id: string; material_id: string; diff: string }[]
    >`
      select b.location_id, b.material_id,
             (b.qty - coalesce((select sum(m.qty) from app.stock_movements m
                                 where m.business_id = b.business_id
                                   and m.location_id = b.location_id
                                   and m.material_id = b.material_id), 0))::text as diff
        from app.stock_balances b where b.business_id = ${this.id}`
    for (const balance of balances) expect(Number(balance.diff), JSON.stringify(balance)).toBe(0)
  }
}
