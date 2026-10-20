import type { CustomerStatementDto, OrderDto } from '@bizcost/contracts'
import { newId, plusDays } from '@bizcost/domain'
import type postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { connectAdmin, type CallResult } from '../helpers'
import { InvoiceScope, InvoicesApi, typed } from '../invoices'
import { ok } from '../purchasing'
import { outcomesOf, Races } from '../races'
import { item } from '../sales'
import { BAKER } from '../settings'

// MONEY + CONCURRENCY ADVERSARY of M3 (Step 10): what is owed is paid once and taken back whole,
// whichever document a payment names and whenever it runs, and a customer's past statement stays as it
// was. Each finding is kept as its test (each failed before its fix): §1 D-332, §2 D-333 and the
// second review's D-338, §3 D-334.
// Every business, customer and figure is fictional.
//
// 1. An order invoiced in part (D-313) takes payments two ways: on its issued invoice, and on the order
//    for "what it owes in all" (its invoices first, then its rest). A payment on the invoice locks the
//    invoice; a payment on the order locks only the order (payments.ts lockReceivable), although
//    everywhere else "an invoice is locked before the order or sale it was made from". Nothing makes
//    the two wait for each other, so both read what is owed before the other commits and both are
//    recorded: the order of 1,050 is paid 1,575. A serial order refuses the second
//    (EXCEEDS_OUTSTANDING). "Pay several at once" naming the invoice, and money given back on either,
//    share the gap.
// 2. "Round the total" to an unreachable total leaves a rounding difference outside every line
//    (1,000.12 at 5% is 1,000.11 + 0.01, D-221). A credit note that takes back every line of such an
//    invoice, or a refund of every line of such an order, takes back 1,000.11: the document still owes
//    0.01, is "unpaid" for ever in What customers owe, and a customer who paid it all gets 1,000.11 back.
//    (D-338) Once fixed, an order refunded whole, a refund reversed and the order refunded again: the
//    statement credited the 0.01 twice and closed at −0.01 where What customers owe said 0.
// 3. A customer's statement of a closed period changes after it: a sale "they'll pay later" or a
//    payment of a closed day, reversed once the books are closed (the reversal dated the first open
//    day), drops out of the closed day's statement, and no later period lists the reversal. D-313: "a
//    past period never changes, each period starts where the one before ended".

const api = new InvoicesApi()
afterAll(() => api.close())

type Hold = (sql: postgres.TransactionSql) => Promise<unknown>
type Run = (instance: number) => Promise<CallResult<unknown>>

/**
 * `hold` takes a lock in an admin transaction; each of `runs` starts on its own instance once the ones
 * before it wait on a lock (or have finished); then the holder commits and they all finish. Unlike
 * Races.interleaved, a refusal is an allowed outcome (what a serial order gives): the results are
 * returned as they are.
 */
async function forced(races: Races, what: string, hold: Hold, runs: readonly Run[]) {
  const holder = connectAdmin()
  try {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let holding!: () => void
    const held = new Promise<void>((resolve) => (holding = resolve))
    const transaction = holder.begin(async (sql) => {
      await hold(sql)
      holding()
      await released
    })
    await held
    const running: Promise<CallResult<unknown>>[] = []
    try {
      const pids = await Promise.all(runs.map((_, i) => races.backendOf(i)))
      for (const [i, run] of runs.entries()) {
        let settled = false
        running.push(run(i).finally(() => (settled = true)))
        for (let tries = 0; ; tries++) {
          if (tries >= 600) throw new Error(`${what}: call ${i} neither waited nor finished`)
          if (settled) break
          const [row] = await api.admin<{ n: number }[]>`
            select count(*)::int as n from pg_locks where not granted and pid = ${pids[i]!}`
          if (row!.n > 0) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    } finally {
      release()
      await transaction
    }
    return await Promise.all(running)
  } finally {
    await holder.end()
  }
}

// ---------------------------------------------------------------------------------------------------
// 1. An order invoiced in part, paid on its invoice and on the order at the same moment
// ---------------------------------------------------------------------------------------------------

describe('an order invoiced in part, paid on its invoice and on the order at the same moment', () => {
  it('is never paid past its total: one of the two payments is refused (EXCEEDS_OUTSTANDING)', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const today = await scope.today()
    const service = await scope.service('1000')
    // 1,000 + VAT 5% = 1,050; a deposit invoice of 50% (525) bills it in part (D-313).
    const order: OrderDto = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '1000' }],
    })
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { percent: '50' }, isDeposit: true }),
    )
    expect(deposit.payable).toBe('525')
    // The order owes 1,050 in all (the deposit invoice's 525, then its rest of 525).
    expect((await scope.getOrder(order.id)).payment).toMatchObject({ owed: '1050' })

    const payment = (document: object, amount: string) => ({
      id: newId(),
      ...document,
      businessDate: today,
      method: 'bank_transfer',
      amount,
    })
    const races = new Races(api.admin, 2)
    let results: CallResult<unknown>[]
    try {
      // Both are held at their insert (the customer row each payment names), after each has read what
      // is owed: the order's 1,050 on the order, the invoice's 525 on the invoice.
      results = await forced(
        races,
        'order payment and invoice payment',
        (sql) => sql`select id from app.customers where id = ${customer.id} for update`,
        [
          (i) =>
            races.call(scope, i, 'customerPayment.record', payment({ orderId: order.id }, '1050')),
          (i) =>
            races.call(
              scope,
              i,
              'customerPayment.record',
              payment({ invoiceId: deposit.id }, '525'),
            ),
        ],
      )
    } finally {
      await races.close()
    }

    // Serially, the second sees nothing (or less) owed and is refused.
    expect(outcomesOf(results).sort()).toEqual(['exceeds_outstanding', 'ok'])
    const [paid] = await api.admin<{ standing: string }[]>`
      select trim_scale(coalesce(sum(p.amount), 0))::text as standing
        from app.customer_payments p
       where p.business_id = ${scope.id} and p.reversed_at is null and p.kind = 'payment'
         and (p.order_id = ${order.id} or p.invoice_id = ${deposit.id})`
    expect(Number(paid!.standing)).toBeLessThanOrEqual(1050)
    expect((await scope.getOrder(order.id)).payment).toMatchObject({ owed: '0', overpaid: '0' })
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------
// 2. A document taken back whole owes nothing, its rounding difference included
// ---------------------------------------------------------------------------------------------------

describe('a document with a rounding difference, taken back whole', () => {
  it('an invoice whose every line a credit note takes back owes nothing, and gives all it was paid back', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    // 952.48 + VAT 5% = 1,000.10, rounded to 1,000.12: 1,000.11 + a rounding difference of 0.01.
    const unpaid = await scope.issued({
      customerId: customer.id,
      lines: [typed('Shelf', '1', '952.48')],
      roundTo: '1000.12',
    })
    expect(unpaid).toMatchObject({
      total: '1000.11',
      roundingDifference: '0.01',
      payable: '1000.12',
    })
    const paid = await scope.issued({
      customerId: customer.id,
      lines: [typed('Cabinet', '1', '952.48')],
      roundTo: '1000.12',
    })
    await scope.payInvoice(paid.id, '1000.12')
    for (const invoice of [unpaid, paid]) {
      const note = await scope.credit(invoice.id, {
        by: 'quantity',
        reason: 'goods_returned',
        reasonText: 'All of it came back',
        lines: [{ invoiceLineId: invoice.lines[0]!.id, qty: '1' }],
      })
      // The credit note that leaves nothing to credit takes back the rounding difference (D-333).
      expect(note).toMatchObject({
        total: '1000.11',
        roundingDifference: '0.01',
        payable: '1000.12',
      })
    }
    // Nothing of either is left: the unpaid one owes nothing, the paid one gives back all it was paid.
    expect((await scope.getInvoice(unpaid.id)).payment).toMatchObject({ owed: '0', overpaid: '0' })
    expect((await scope.getInvoice(paid.id)).payment).toMatchObject({
      owed: '0',
      overpaid: '1000.12',
    })
    expect(await scope.receivables({ customerId: customer.id })).toMatchObject({
      owed: '0',
      overpaid: '1000.12',
    })
  }, 90_000)

  it('an order whose every line is refunded owes nothing', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const service = await scope.service('952.48')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      roundTo: '1000.12',
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '952.48' }],
    })
    expect(order).toMatchObject({ total: '1000.11', roundingDifference: '0.01' })
    const delivered = await scope.deliver(order)
    const sale = await scope.sale(delivered.saleId!)
    await scope.refund({
      orderId: order.id,
      by: 'quantity',
      businessDate: await scope.today(),
      lines: [{ lineId: sale.lines.find((l) => l.kind === 'item')!.id, qty: '1' }],
      notes: 'All of it came back',
    })
    expect((await scope.getOrder(order.id)).payment).toMatchObject({ owed: '0', overpaid: '0' })
  }, 90_000)

  // The second review of the fixes: the statement credited the order's rounding difference on the
  // refund that "took back all that was left as it stood when it was made", counting an earlier refund
  // reversed since, while What customers owe counts it while the refunds that stand take back all of
  // the sale. Once a refund was reversed and the order refunded again, the 0.01 was credited twice: the
  // statement closed at −0.01 where What customers owe said 0 (D-313: they never disagree).
  async function roundedOrder(scope: InvoiceScope, day: string) {
    const customer = await scope.buyer()
    const service = await scope.service('476.24')
    // 2 × 476.24 + VAT 5% = 1,000.10, rounded to 1,000.12: 1,000.11 + a rounding difference of 0.01.
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      businessDate: day,
      roundTo: '1000.12',
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '2', unitPrice: '476.24' }],
    })
    expect(order).toMatchObject({ total: '1000.11', roundingDifference: '0.01' })
    const delivered = await scope.deliver(order, day)
    const sale = await scope.sale(delivered.saleId!)
    const lineId = sale.lines.find((l) => l.kind === 'item')!.id
    const refundOne = (businessDate: string) =>
      scope.refund({
        orderId: order.id,
        by: 'quantity',
        businessDate,
        lines: [{ lineId, qty: '1' }],
        notes: 'One came back',
      })
    // The statement's closing is What customers owe's figure for the order, whatever happened.
    const agree = async (from: string, owed: string) => {
      const today = await scope.today()
      expect((await scope.getOrder(order.id)).payment).toMatchObject({ owed, overpaid: '0' })
      expect(await scope.receivables({ customerId: customer.id })).toMatchObject({
        owed,
        overpaid: '0',
      })
      expect((await scope.statement(customer.id, from, today)).closing).toBe(owed)
    }
    return { customer, refundOne, agree }
  }

  it('an order refunded whole, a refund reversed and refunded again: the statement agrees with What customers owe', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const today = await scope.today()
    const { refundOne, agree } = await roundedOrder(scope, today)
    const first = await refundOne(today)
    await refundOne(today)
    await agree(today, '0')
    // Reversed on its own (open) day: it never counted, so the other refund took back only 500.05.
    await scope.reverseSale(first.id)
    await agree(today, '500.07')
    await refundOne(today)
    await agree(today, '0')
  }, 120_000)

  it('the same once the refunds’ day is closed: the reversal on the first open day charges the 0.01 back', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const today = await scope.today()
    const day = plusDays(today, -2)
    const { customer, refundOne, agree } = await roundedOrder(scope, day)
    const first = await refundOne(day)
    await refundOne(day)
    await agree(day, '0')
    ok(await scope.run('books.close', { closedThrough: plusDays(today, -1) }))
    const reversed = await scope.reverseSale(first.id)
    expect(reversed.reversalBusinessDate).toBe(today)
    await agree(day, '500.07')
    // The closed day is as it was: refunded whole, its rounding difference included.
    expect((await scope.statement(customer.id, day, day)).closing).toBe('0')
    await refundOne(today)
    await agree(day, '0')
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------
// 3. A closed period's statement never changes after it
// ---------------------------------------------------------------------------------------------------

describe("a customer's statement of a closed day, after a reversal dated the first open day", () => {
  const sums = (s: CustomerStatementDto) => ({
    opening: s.opening,
    invoiced: s.invoiced,
    paid: s.paid,
    closing: s.closing,
  })

  async function closedDay() {
    const shop = await InvoiceScope.open(api, BAKER)
    const today = await shop.today()
    const day = plusDays(today, -2)
    const box = await shop.product({
      name: `Cookie box ${newId().slice(0, 8)}`,
      defaultPrice: '100',
    })
    const customer = await shop.customer()
    const sale = await shop.sell({
      businessDate: day,
      customerId: customer.id,
      payLater: true,
      lines: [item(box.id, '1', '100')],
    })
    return { shop, today, day, customer, sale }
  }

  it('a sale they pay later, reversed once its day is closed: the closed day stays, the reversal is listed after it', async () => {
    const { shop, today, day, customer, sale } = await closedDay()
    expect(sums(await shop.statement(customer.id, day, day))).toEqual({
      opening: '0',
      invoiced: '100',
      paid: '0',
      closing: '100',
    })
    ok(await shop.run('books.close', { closedThrough: plusDays(today, -1) }))
    // The books keep the sale on its closed day; its reversal posts on the first open day (today).
    const reversed = await shop.reverseSale(sale.id)
    expect(reversed.reversalBusinessDate).toBe(today)

    expect(sums(await shop.statement(customer.id, day, day))).toMatchObject({ closing: '100' })
    const after = await shop.statement(customer.id, plusDays(day, 1), today)
    expect(after).toMatchObject({ opening: '100', closing: '0' })
    expect(after.entries).toHaveLength(1)
  }, 90_000)

  it('a payment of a closed day, reversed once it is closed: the closed day stays, the reversal is listed after it', async () => {
    const { shop, today, day, customer, sale } = await closedDay()
    const paid = await shop.pay({ saleId: sale.id }, '60', { businessDate: day })
    expect(sums(await shop.statement(customer.id, day, day))).toEqual({
      opening: '0',
      invoiced: '100',
      paid: '60',
      closing: '40',
    })
    ok(await shop.run('books.close', { closedThrough: plusDays(today, -1) }))
    ok(await shop.run('customerPayment.reverse', { id: paid.items[0]!.id }))

    expect(sums(await shop.statement(customer.id, day, day))).toMatchObject({ closing: '40' })
    const after = await shop.statement(customer.id, plusDays(day, 1), today)
    expect(after).toMatchObject({ opening: '40', closing: '100' })
  }, 90_000)
})
