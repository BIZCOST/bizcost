import type {
  BusinessContextDto,
  CostCategoryDto,
  ExpenseDto,
  MemberPermissionsDto,
  PurchaseDto,
} from '@bizcost/contracts'
import { addMonths, monthOf, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from '../expenses'
import { codeOf, line, ok, purchaseInput, type Person } from '../purchasing'
import { WORKSHOP } from '../settings'

// Security review of M2 Step 7 (the Costing Core's release), second pass: what is still open. Each
// test states what the rules ask for; a failing test is a finding.
//
// 1. "For which month?" and the books-closed date. D-114 rule 6 / D-137: the books-closed date is set
//    only with settings.books.close (the Owner and Admin templates), and "nothing dated on or before
//    it can be posted or reversed", so a closed period no longer changes. D-194: an expense now also
//    says the month it is for (`period_month`, up to 12 months before its bill's month), and "real
//    profit (Phase 3) counts each expense in its period_month, not its bill's date". Posting checks
//    only the bill's date (assertPostable(business, head.business_date)), so an expense dated in the
//    open period lands in a closed month:
//      - a Manager (no settings.books.close) finalizes a bill dated today "for" a month the owner
//        closed;
//      - the default month of a utility bill (billed the month after, D-194) puts the first bill after
//        a month-end close into the closed month without anyone choosing it;
//      - a correction's copy keeps the closed month (D-194: "a correction's copy keeps it") and posts.
// 2. The one switch "See costs, supplier prices and margins" (D-190, D-196) turned off for one member
//    leaves them keys that grant nothing without supplier prices: approving expenses (D-175: FORBIDDEN
//    without them; "the Roles editor has no sensitive-data switches until Step 7, which should pair
//    them") and recording payments (D-160). D-190: "a key that grants nothing must not show as
//    granted, nor let its holder pass 'no access beyond your own'".
// 3. "Changing what one cannot see" (D-184, ARCHITECTURE.md §Redaction) holds for expenses only. The
//    same manager kept from costs keeps purchases.documents.manage ("+ New purchase") and changes or
//    discards another member's purchase draft whose prices are locked to them (the web says "This
//    draft has prices your role doesn't show, so it can't be edited here"; the API takes it).

let api: ExpensesApi

beforeAll(() => {
  api = new ExpensesApi()
})

afterAll(async () => {
  await api.close()
})

/** The day before `date` (YYYY-MM-DD). */
function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  return day.toISOString().slice(0, 10)
}

/** The last day of the month `count` months from today's month (count < 0: back). */
const lastDayOf = (today: string, count: number) =>
  dayBefore(`${addMonths(monthOf(today), count + 1)}-01`)

interface Shop {
  scope: ExpenseScope
  today: string
  manager: Person & { memberId: string }
  rent: CostCategoryDto
  electricity: CostCategoryDto
}

/** A business of its own (approval off: the default), with a Manager who finalizes expenses. */
async function openShop(): Promise<Shop> {
  const scope = await ExpenseScope.open(api, WORKSHOP)
  const today = await scope.today()
  const manager = await api.member(scope, 'manager')
  const categories = await scope.categories()
  return {
    scope,
    today,
    manager,
    rent: categories.find((c) => c.name === 'Rent')!,
    electricity: categories.find((c) => c.name === 'Electricity')!,
  }
}

/** Creates the expense as `who` and finalizes it: the draft, and the result of expense.post. */
async function enterAndPost(shop: Shop, who: Person, input: object) {
  const draft = ok(await shop.scope.as<Envelope<ExpenseDto>>(who, 'expense.create', input)).data
  const posted = await shop.scope.as<Envelope<ExpenseDto>>(who, 'expense.post', {
    id: draft.id,
    version: draft.version,
  })
  return { draft, posted }
}

describe('"For which month?" never reopens closed books (D-114 rule 6, D-137, D-194)', () => {
  it('a Manager, who may not close or reopen the books, cannot finalize an expense for a closed month', async () => {
    const shop = await openShop()
    // The owner closes the books through the end of the month before last.
    const closedThrough = lastDayOf(shop.today, -2)
    ok(await shop.scope.run('books.close', { closedThrough }))
    const closedMonth = monthOf(closedThrough)
    // The Manager may not move that date (settings.books.close is the Owner's and Admin's only) ...
    expect(codeOf(await shop.scope.as(shop.manager, 'books.close', { closedThrough: null }))).toBe(
      'forbidden',
    )
    // ... but dates a bill today (the open period) and says it is for the closed month. Expected:
    // BOOKS_CLOSED, as for a bill dated in that month.
    const { draft, posted } = await enterAndPost(
      shop,
      shop.manager,
      shop.scope.expenseInput(shop.rent.id, shop.today, { vatRate: '0', periodMonth: closedMonth }),
    )
    expect(draft.periodMonth).toBe(closedMonth)
    expect(
      codeOf(posted),
      `an expense for ${closedMonth} (books closed through ${closedThrough}) was finalized`,
    ).toBe('books_closed')
  })

  it('the default month of a utility bill does not put it in a closed month', async () => {
    const shop = await openShop()
    // A month-end close: the books are closed through the last day of last month.
    const closedThrough = lastDayOf(shop.today, -1)
    ok(await shop.scope.run('books.close', { closedThrough }))
    // Last month's electricity bill arrives this month. Nobody chooses its month: the default (the
    // month before the bill's date, D-194) is the closed month.
    const { draft, posted } = await enterAndPost(
      shop,
      shop.scope.owner,
      shop.scope.expenseInput(shop.electricity.id, shop.today, { vatRate: '0' }),
    )
    const finalized = codeOf(posted) === undefined
    // Expected: either it is refused (BOOKS_CLOSED) until an open month is chosen, or the month it
    // was finalized for is open; never a finalized expense in a closed month.
    if (finalized) {
      expect(
        draft.periodMonth > monthOf(closedThrough),
        `finalized for ${draft.periodMonth} with the books closed through ${closedThrough}`,
      ).toBe(true)
    } else {
      expect(codeOf(posted)).toBe('books_closed')
    }
  })

  it("a correction's copy of an expense for a month closed since cannot be finalized in that month", async () => {
    const shop = await openShop()
    const lastMonth = addMonths(monthOf(shop.today), -1)
    // Finalized while the books are open: a bill dated today, for last month.
    const { posted } = await enterAndPost(
      shop,
      shop.manager,
      shop.scope.expenseInput(shop.rent.id, shop.today, { vatRate: '0', periodMonth: lastMonth }),
    )
    const original = ok(posted).data
    // The owner then closes last month.
    ok(await shop.scope.run('books.close', { closedThrough: lastDayOf(shop.today, -1) }))
    // The Manager corrects it: the copy keeps its month (closed) and its date (open) ...
    const copy = ok(
      await shop.scope.as<Envelope<ExpenseDto>>(shop.manager, 'expense.correct', {
        id: original.id,
        newId: newId(),
      }),
    ).data
    expect(copy.periodMonth).toBe(lastMonth)
    const changed = ok(
      await shop.scope.as<Envelope<ExpenseDto>>(shop.manager, 'expense.update', {
        ...shop.scope.expenseInput(shop.rent.id, shop.today, {
          vatRate: '0',
          amount: '900',
          periodMonth: lastMonth,
        }),
        id: copy.id,
        version: copy.version,
      }),
    ).data
    // ... and finalizes another amount into it. Expected: BOOKS_CLOSED while that month is closed.
    const result = await shop.scope.as(shop.manager, 'expense.post', {
      id: changed.id,
      version: changed.version,
    })
    expect(codeOf(result), `a new amount was finalized for the closed month ${lastMonth}`).toBe(
      'books_closed',
    )
  })

  it('a reversal counts in its own month while it is open, else in the first open month (D-200)', async () => {
    const shop = await openShop()
    const thisMonth = monthOf(shop.today)
    const lastMonth = addMonths(thisMonth, -1)
    const post = async (periodMonth: string) =>
      ok(
        (
          await enterAndPost(
            shop,
            shop.scope.owner,
            shop.scope.expenseInput(shop.rent.id, shop.today, { vatRate: '0', periodMonth }),
          )
        ).posted,
      ).data
    const reversedBefore = await post(lastMonth)
    const reversedAfter = await post(lastMonth)
    const current = await post(thisMonth)
    // Reversed while last month is open: it stops counting in last month.
    ok(await shop.scope.run('expense.reverse', { id: reversedBefore.id }))
    // The month-end close; then the two others are reversed.
    ok(await shop.scope.run('books.close', { closedThrough: lastDayOf(shop.today, -1) }))
    ok(await shop.scope.run('expense.reverse', { id: reversedAfter.id }))
    ok(await shop.scope.run('expense.reverse', { id: current.id }))
    const rows = await shop.scope.api.admin<{ id: string; month: string; day: string }[]>`
      select id, to_char(reversal_period_month, 'YYYY-MM') as month, reversal_date::text as day
        from app.expenses
       where business_id = ${shop.scope.id} and status = 'reversed'`
    const monthOfReversal = new Map(rows.map((row) => [row.id, row.month]))
    expect(monthOfReversal.get(reversedBefore.id)).toBe(lastMonth)
    // Last month is closed: its figures stay as they were, and the reversal counts in this month.
    expect(monthOfReversal.get(reversedAfter.id)).toBe(thisMonth)
    expect(monthOfReversal.get(current.id)).toBe(thisMonth)
    expect(new Set(rows.map((row) => row.day))).toEqual(new Set([shop.today]))
  })
})

/** The one switch "See costs, supplier prices and margins" (D-190). */
const COSTS = ['data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view']
/** Keys whose every use needs supplier prices visible (FORBIDDEN before anything is read). */
const NEED_SUPPLIER_PRICES = [
  'expenses.documents.approve',
  'expenses.payments.record',
  'purchases.payments.record',
]

describe('the costs switch turned off for one member takes what needs it too (D-175, D-190)', () => {
  it('a manager kept from costs does not keep "Approve expenses" and "Record payments" as dead keys', async () => {
    const shop = await openShop()
    const { scope, manager, today } = shop
    ok(await scope.run('expense.updateSettings', { approval: true }))
    // The owner keeps this one manager from costs, supplier prices and margins: the one switch of
    // their permissions page (D-196), i.e. the three data keys taken away together.
    const read = ok(
      await scope.run<MemberPermissionsDto>('member.permissions', { memberId: manager.memberId }),
    )
    const saved = await scope.run<MemberPermissionsDto>('member.updatePermissions', {
      memberId: manager.memberId,
      version: read.version,
      overrides: COSTS.map((key) => ({ key, effect: 'deny' as const })),
    })
    // Refusing the save until those keys are switched off too (VALIDATION, as for any key missing
    // what it needs) is one way to keep the rule.
    if (codeOf(saved) === 'validation') return

    // The keys grant nothing now: each use is refused before anything is read.
    const someone = newId()
    expect(codeOf(await scope.as(manager, 'expense.approve', { id: someone, version: 1 }))).toBe(
      'forbidden',
    )
    const payment = { id: newId(), businessDate: today, method: 'cash', amount: '1' }
    expect(
      codeOf(await scope.as(manager, 'expensePayment.record', { ...payment, expenseId: someone })),
    ).toBe('forbidden')
    expect(
      codeOf(
        await scope.as(manager, 'purchasePayment.record', { ...payment, purchaseId: someone }),
      ),
    ).toBe('forbidden')

    // Expected: they do not show as granted (D-190), in the page's "what they can do now" and in
    // the member's own access (business.context, which the screens and "+" follow).
    const effective = ok(saved).effectiveKeys
    expect(
      NEED_SUPPLIER_PRICES.filter((key) => effective.includes(key)),
      'member.permissions effectiveKeys: keys that grant nothing',
    ).toEqual([])
    const context = ok(await scope.as<BusinessContextDto>(manager, 'business.context'))
    expect(
      NEED_SUPPLIER_PRICES.filter((key) => context.permissions.keys.includes(key)),
      'business.context permissions: keys that grant nothing',
    ).toEqual([])
  })
})

describe("changing what one cannot see: another member's purchase draft (D-184, D-196)", () => {
  /** The owner keeps the shop's manager from costs, and from what needs them (one save, whole). */
  async function keepFromCosts(shop: Shop): Promise<void> {
    const { scope, manager } = shop
    const read = ok(
      await scope.run<MemberPermissionsDto>('member.permissions', { memberId: manager.memberId }),
    )
    ok(
      await scope.run<MemberPermissionsDto>('member.updatePermissions', {
        memberId: manager.memberId,
        version: read.version,
        overrides: [...COSTS, ...NEED_SUPPLIER_PRICES].map((key) => ({
          key,
          effect: 'deny' as const,
        })),
      }),
    )
  }

  it("a manager kept from costs cannot overwrite or discard the owner's purchase draft", async () => {
    const shop = await openShop()
    const { scope, manager, today } = shop
    await keepFromCosts(shop)
    const material = await scope.material()
    // The owner's draft: 10 L at 7.
    const input = purchaseInput(today, [line(material.id, '10', '7')])
    const draft = await scope.draft(input)
    // The manager reads it with its prices locked ...
    const seen = ok(
      await scope.as<Envelope<PurchaseDto>>(manager, 'purchase.get', { id: draft.id }),
    )
    expect(seen.meta.redacted.length).toBeGreaterThan(0)
    // ... and saves it whole with a price of their own (they cannot know the one they replace).
    // Expected: FORBIDDEN, as expense.update refuses another member's expense to a member without
    // supplier prices (D-184).
    const overwrite = await scope.as<Envelope<PurchaseDto>>(manager, 'purchase.update', {
      ...input,
      id: draft.id,
      version: draft.version,
      lines: [line(material.id, '10', '70', { id: (input.lines[0] as { id: string }).id })],
    })
    expect(codeOf(overwrite), "the manager changed the owner's hidden price").toBe('forbidden')
    const [row] = await scope.api.admin<{ unit_price: string }[]>`
      select trim_scale(unit_price)::text as unit_price from app.purchase_lines
       where business_id = ${scope.id} and purchase_id = ${draft.id} and deleted_at is null`
    expect(row?.unit_price, "the owner's price").toBe('7')
    // Nor are receipts added to it (D-200, as for expenses, D-184).
    const upload = await scope.as(manager, 'attachment.uploadUrl', {
      entity: 'purchase',
      entityId: draft.id,
      contentType: 'image/png',
    })
    expect(codeOf(upload), "the manager added a file to the owner's draft").toBe('forbidden')
    // Nor is it taken out by someone who cannot see what it holds.
    const current = await scope.run<Envelope<PurchaseDto>>('purchase.get', { id: draft.id })
    const discard = await scope.as(manager, 'purchase.discard', {
      id: draft.id,
      version: ok(current).data.version,
    })
    expect(codeOf(discard), "the manager discarded the owner's draft").toBe('forbidden')
    // Their own draft is theirs to change (its prices are theirs: purchase.get shows them nothing
    // else), and to take out.
    const own = ok(
      await scope.as<Envelope<PurchaseDto>>(
        manager,
        'purchase.create',
        purchaseInput(today, [line(material.id, '2', '5')]),
      ),
    ).data
    ok(await scope.as(manager, 'purchase.discard', { id: own.id, version: own.version }))
  })
})
