import type {
  ProductCostListDto,
  ProductCostRowDto,
  PurchaseDto,
  PurchaseReturnDto,
} from '@bizcost/contracts'
import { businessMembers, withTenantTx } from '@bizcost/db'
import { compareDecimal, newId, replayWac, type WacMovement } from '@bizcost/domain'
import { NO_ADJUSTMENTS, QUESTION_SET_VERSION } from '@bizcost/modules'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DemoApi } from '../demo/client'
import { seedCosting } from '../demo/costing'
import { DEMO_EMAIL_DOMAIN, DEMO_PERSONAS, type DemoPersona } from '../demo/personas'
import { mutate, tenant } from './helpers'
import { ledgerDrift } from './ledger'
import {
  codeOf,
  line,
  milkInput,
  ok,
  purchaseInput,
  PurchasingApi,
  Scope,
  type Person,
} from './purchasing'
import { templateRoleId, WORKSHOP } from './settings'

// The ledger rebuild equals the projections (M2 Step 8; D-110 rule 2, D-135): replaying every
// material's ledger in posting order (replayWac) gives its stored cost row, last movement, every
// movement's adjustment and every balance (ledgerDrift, test/ledger.ts), for
//   - the demo businesses: each persona's Costing Core data (demo/costing-data.ts) entered into a new
//     business of the persona's own Smart Setup answers, through the API exactly as `pnpm demo:seed`
//     enters it (seedCosting); and the demo businesses `pnpm demo:seed` made on this database, when
//     there are any;
//   - generated sequences (fast-check) of purchases, returns, credit notes and reversals of purchases,
//     returns and credit notes on two shared materials at two locations, through the API one after
//     the other. There an independent model (replayWac over what each posted document says, in the
//     order they were posted) also gives the stored cost rows, and the value each return took.
// Refusals the API gives on purpose (more than is left, a purchase with returns, a later return) are
// part of the sequences: they must leave everything as it was.

let api: PurchasingApi
let demo: DemoApi

beforeAll(async () => {
  api = new PurchasingApi()
  demo = await DemoApi.open()
}, 60_000)

afterAll(async () => {
  await demo?.close()
  await api?.close()
})

/** A member of `businessId` with the persona member's email and name, as an accepted invitation. */
async function joinAs(
  owner: Person,
  businessId: string,
  member: NonNullable<DemoPersona['team']>[number],
): Promise<Person> {
  const person = await api.person()
  const roleId = await templateRoleId(api.db, owner.user, businessId, member.role)
  await withTenantTx(api.db, tenant(owner.user.id, businessId), (tx) =>
    tx.insert(businessMembers).values({
      id: newId(),
      businessId,
      userId: person.user.id,
      kind: 'account',
      displayName: member.name,
      email: member.email,
      status: 'active',
      roleId,
    }),
  )
  return person
}

/** A new business for the persona (its answers, review changes, profile, branches and team). */
async function personaBusiness(persona: DemoPersona) {
  const owner = await api.person()
  const businessId = newId()
  ok(
    await mutate(api.handler, 'business.createFromSetup', {
      token: owner.token,
      input: {
        businessId,
        legalName: `${persona.legalName} ${newId().slice(-6)}`,
        locale: persona.owner.locale,
        questionSetVersion: QUESTION_SET_VERSION,
        answers: persona.answers,
        adjustments: persona.adjustments ?? NO_ADJUSTMENTS,
      },
    }),
  )
  if (persona.trn) {
    const profile = ok(
      await api.call<{ version: number; legalName: string; vatRegistered: boolean }>(
        owner,
        businessId,
        'business.profile',
      ),
    )
    ok(
      await api.call(owner, businessId, 'business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: persona.legalNameAr,
        vatRegistered: profile.vatRegistered,
        trn: persona.trn,
      }),
    )
  }
  for (const name of persona.branches ?? []) {
    ok(await api.call(owner, businessId, 'location.create', { id: newId(), name }))
  }
  const tokens = new Map<string, string>()
  for (const member of persona.team ?? []) {
    if (member.joined) tokens.set(member.email, (await joinAs(owner, businessId, member)).token)
  }
  return { owner, businessId, tokens }
}

describe('the demo businesses: the rebuild from the ledger equals the projections', () => {
  const personas = DEMO_PERSONAS.filter((p) => p.costing)

  it.each(personas.map((p) => [p.title, p] as const))(
    '%s, entered as demo:seed enters it',
    async (_title, persona) => {
      const { owner, businessId, tokens } = await personaBusiness(persona)
      const seeded = await seedCosting(
        {
          api: demo,
          token: owner.token,
          businessId,
          label: persona.legalName,
          locale: persona.owner.locale,
          tokenOf: (email) => {
            const token = tokens.get(email)
            return token
              ? Promise.resolve(token)
              : Promise.reject(new Error(`${email} did not join`))
          },
        },
        persona.costing!,
      )
      expect(seeded.warnings).toEqual([])
      const [count] = await api.admin<{ n: number }[]>`
        select count(*)::int as n from app.stock_movements where business_id = ${businessId}`
      const bought = (persona.costing!.purchases ?? []).length
      expect(count!.n > 0, `${persona.title}: movements`).toBe(bought > 0)
      expect(await ledgerDrift(api.admin, businessId)).toEqual([])

      // demo:seed shows costed products (the M2 definition of done): every product and service of
      // the persona is on Product costs, its cost worked out and complete (nothing to add).
      const rows: ProductCostRowDto[] = []
      let cursor: string | undefined
      do {
        const page = ok(
          await api.call<ProductCostListDto>(owner, businessId, 'productCost.list', {
            status: 'all',
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        ).data
        rows.push(...page.items)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      const products = persona.costing!.products ?? []
      expect(rows.map((row) => row.name).sort()).toEqual(products.map((p) => p.name).sort())
      for (const row of rows) {
        expect(
          { name: row.name, complete: row.cost.complete, unpriced: row.unpricedLines },
          `${persona.title}: ${(row.cost.reasons ?? []).join(', ')}`,
        ).toEqual({ name: row.name, complete: true, unpriced: 0 })
        // A total, unless a service without materials waits only for its share of running costs.
        if (row.lineCount > 0)
          expect(row.cost.total, `${persona.title}: ${row.name}`).not.toBeNull()
      }
    },
    120_000,
  )

  it('the demo businesses on this database (pnpm demo:seed), if any', async () => {
    const businesses = await api.admin<{ id: string; legal_name: string }[]>`
      select b.id, b.legal_name
        from app.businesses b
        join auth.users u on u.id = b.created_by
       where lower(u.email) like ${`%@${DEMO_EMAIL_DOMAIN}`} and b.deleted_at is null`
    // Says so when there are none (CI never runs demo:seed): the personas above are the proof there.
    if (businesses.length === 0) {
      console.info('No demo business on this database: run pnpm demo:seed to check them too.')
    }
    for (const business of businesses) {
      expect(await ledgerDrift(api.admin, business.id), business.legal_name).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Generated sequences
// ---------------------------------------------------------------------------------------------------

type Op =
  | {
      kind: 'buy'
      lines: { m: number; qty: number; cents: number; carton: boolean }[]
      branch: boolean
    }
  | { kind: 'return'; pick: number; line: number; percent: number }
  | { kind: 'credit'; pick: number; line: number; percent: number }
  | { kind: 'reverse purchase'; pick: number }
  | { kind: 'reverse return'; pick: number }

const buyArb = fc.record({
  kind: fc.constant('buy' as const),
  lines: fc.uniqueArray(
    fc.record({
      m: fc.integer({ min: 0, max: 1 }),
      qty: fc.integer({ min: 1, max: 40 }),
      cents: fc.integer({ min: 0, max: 5000 }),
      carton: fc.boolean(),
    }),
    { minLength: 1, maxLength: 2, selector: (l) => l.m },
  ),
  branch: fc.boolean(),
})
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: buyArb },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('return' as const),
      pick: fc.nat(),
      line: fc.nat(),
      percent: fc.integer({ min: 1, max: 100 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('credit' as const),
      pick: fc.nat(),
      line: fc.nat(),
      percent: fc.integer({ min: 1, max: 100 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('reverse purchase' as const), pick: fc.nat() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('reverse return' as const), pick: fc.nat() }),
  },
)

/**
 * One sequence that always runs (with the generated ones): every kind of posting and reversal, and
 * a purchase reversed only after its return and credit note are.
 */
const EVERY_KIND: Op[] = [
  {
    kind: 'buy',
    lines: [
      { m: 0, qty: 10, cents: 600, carton: false },
      { m: 1, qty: 2, cents: 7200, carton: true },
    ],
    branch: false,
  },
  { kind: 'buy', lines: [{ m: 0, qty: 5, cents: 700, carton: false }], branch: true },
  { kind: 'return', pick: 0, line: 0, percent: 50 },
  { kind: 'credit', pick: 0, line: 1, percent: 25 },
  { kind: 'reverse purchase', pick: 0 },
  { kind: 'reverse return', pick: 0 },
  { kind: 'reverse return', pick: 0 },
  { kind: 'reverse purchase', pick: 0 },
  { kind: 'return', pick: 0, line: 0, percent: 100 },
  { kind: 'credit', pick: 0, line: 0, percent: 50 },
]

/** A decimal string in cents ("12.34") of a whole number of cents. */
const money = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

/** Cents of a money string with at most 4 decimals, rounded down. */
function centsOf(value: string): number {
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))
  return negative ? -cents : cents
}

/** Refusals the API gives on purpose: the document does not fit what was posted. */
const EXPECTED_REFUSALS = new Set([
  'exceeds_purchase',
  'purchase_has_returns',
  'has_later_returns',
  'document_not_posted',
])

describe('generated sequences of postings: the rebuild equals the projections and a model', () => {
  let shop: Scope
  let today: string
  let branch: string

  beforeAll(async () => {
    shop = await Scope.open(api, WORKSHOP)
    today = await shop.today()
    branch = ok(
      await shop.run<{ id: string }>('location.create', { id: newId(), name: 'Branch' }),
    ).id
  })

  it('purchases, returns, credit notes and their reversals, in any order', async () => {
    // What the sequences did, over every run (so a run that refuses everything cannot pass unseen).
    const seen = new Map<string, number>()
    const saw = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1)
    const refused = (result: { raw: string }, code: string | undefined) => {
      expect(EXPECTED_REFUSALS.has(code ?? ''), result.raw).toBe(true)
      saw('refused')
    }
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
        const milk = [milkInput(), milkInput()]
        const materials = [await shop.material(milk[0]!.input), await shop.material(milk[1]!.input)]
        const purchases: PurchaseDto[] = []
        const documents: PurchaseReturnDto[] = []
        // The model: what each posted document says, in the order they were posted.
        const model: WacMovement[] = []
        const returnCosts = new Map<string, string>()

        for (const op of ops) {
          if (op.kind === 'buy') {
            const lines = op.lines.map((l) =>
              l.carton
                ? line(materials[l.m]!.id, String(l.qty), money(l.cents), {
                    unit: undefined,
                    packId: milk[l.m]!.carton,
                  })
                : line(materials[l.m]!.id, String(l.qty), money(l.cents)),
            )
            const extra = op.branch ? { locationId: branch } : {}
            const purchase = await shop.buy(purchaseInput(today, lines, extra))
            purchases.push(purchase)
            saw('buy')
            for (const l of purchase.lines) {
              model.push({
                type: 'receipt',
                id: l.id,
                qty: l.baseQty!,
                value: l.cost!,
              } as WacMovement)
            }
            continue
          }
          if (op.kind === 'return' || op.kind === 'credit') {
            const live = purchases.filter((p) => p.status === 'posted')
            if (live.length === 0) continue
            const chosen = live[op.pick % live.length]!
            const purchase = ok(
              await shop.run<{ data: PurchaseDto }>('purchase.get', { id: chosen.id }),
            ).data
            const target = purchase.lines[op.line % purchase.lines.length]!
            let input: { qty: string } | { amount: string }
            if (op.kind === 'return') {
              const left = Number(target.qty) - Number(target.returnedQty)
              if (left <= 0) continue
              input = { qty: String(Math.max(1, Math.floor((left * op.percent) / 100))) }
            } else {
              const left =
                centsOf(target.net ?? '0') -
                centsOf(target.returnedAmount ?? '0') -
                centsOf(target.creditedAmount ?? '0')
              if (left <= 0) continue
              input = { amount: money(Math.max(1, Math.floor((left * op.percent) / 100))) }
            }
            const draft = await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.create', {
              id: newId(),
              purchaseId: purchase.id,
              kind: op.kind === 'return' ? 'return' : 'credit_note',
              businessDate: today,
              lines: [{ id: newId(), purchaseLineId: target.id, ...input }],
            })
            if (draft.error) {
              refused(draft, codeOf(draft))
              continue
            }
            const result = await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.post', {
              id: draft.data!.data.id,
              version: draft.data!.data.version,
            })
            if (result.error) {
              refused(result, codeOf(result))
              continue
            }
            const posted = result.data!.data
            documents.push(posted)
            saw(posted.kind)
            for (const l of posted.lines) {
              if (posted.kind === 'return') {
                model.push({
                  type: 'return',
                  id: l.id,
                  receiptId: l.purchaseLineId,
                  qty: l.baseQty!,
                } as WacMovement)
                returnCosts.set(l.id, l.cost!)
              } else {
                model.push({
                  type: 'credit',
                  id: l.id,
                  receiptId: l.purchaseLineId,
                  amount: l.cost!,
                } as WacMovement)
              }
            }
            continue
          }
          if (op.kind === 'reverse purchase') {
            const live = purchases.filter((p) => p.status === 'posted')
            if (live.length === 0) continue
            const chosen = live[op.pick % live.length]!
            const result = await shop.run<{ data: PurchaseDto }>('purchase.reverse', {
              id: chosen.id,
            })
            if (result.error) {
              refused(result, codeOf(result))
              continue
            }
            purchases[purchases.indexOf(chosen)] = result.data!.data
            saw('reverse purchase')
            for (const l of chosen.lines) model.push({ type: 'receipt_reversal', receiptId: l.id })
            continue
          }
          const live = documents.filter((d) => d.status === 'posted')
          if (live.length === 0) continue
          const chosen = live[op.pick % live.length]!
          const result = await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.reverse', {
            id: chosen.id,
          })
          if (result.error) {
            refused(result, codeOf(result))
            continue
          }
          documents[documents.indexOf(chosen)] = result.data!.data
          saw(`reverse ${chosen.kind}`)
          for (const l of chosen.lines) {
            model.push(
              chosen.kind === 'return'
                ? { type: 'return_reversal', returnId: l.id }
                : { type: 'credit_reversal', creditId: l.id },
            )
          }
        }

        // The model, per material, gives the stored cost rows and the value each return took.
        for (const [index, material] of materials.entries()) {
          const lineIds = new Set(
            purchases.flatMap((p) =>
              p.lines.filter((l) => l.materialId === material.id).map((l) => l.id),
            ),
          )
          const returnLineIds = new Set(
            documents.flatMap((d) =>
              d.lines.filter((l) => lineIds.has(l.purchaseLineId)).map((l) => l.id),
            ),
          )
          const mine = model.filter((m) =>
            m.type === 'receipt'
              ? lineIds.has(m.id)
              : m.type === 'receipt_reversal'
                ? lineIds.has(m.receiptId)
                : m.type === 'return' || m.type === 'credit'
                  ? returnLineIds.has(m.id)
                  : m.type === 'return_reversal'
                    ? returnLineIds.has(m.returnId)
                    : m.type === 'credit_reversal' && returnLineIds.has(m.creditId),
          )
          const replay = replayWac(mine)
          const row = await shop.costRow(material.id)
          if (mine.length === 0) {
            expect(row, `material ${index}`).toBeUndefined()
            continue
          }
          expect(row, `material ${index}`).toEqual({
            qty: replay.state.qty,
            value: replay.state.value,
            avg_cost: replay.state.avgCost,
          })
          for (const [i, movement] of mine.entries()) {
            if (movement.type !== 'return') continue
            const step = replay.steps[i]!
            expect(compareDecimal(step.valueOut, returnCosts.get(movement.id)!), movement.id).toBe(
              0,
            )
          }
        }
        expect(await ledgerDrift(api.admin, shop.id)).toEqual([])
      }),
      { numRuns: 15, examples: [[EVERY_KIND]] },
    )
    for (const what of [
      'buy',
      'return',
      'credit_note',
      'reverse purchase',
      'reverse return',
      'reverse credit_note',
      'refused',
    ]) {
      expect(seen.get(what) ?? 0, what).toBeGreaterThan(0)
    }
  }, 600_000)
})
