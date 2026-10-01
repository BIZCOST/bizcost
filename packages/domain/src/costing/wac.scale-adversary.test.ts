import { describe, expect, it } from 'vitest'
import type { CostAmount, Quantity } from '../numbers/kinds'
import { replayWac, type WacMovement } from './wac'

// Ledger adversary (M2 Step 8, the posting machinery): every supplier return, credit note and reversal
// replays its material's WHOLE ledger (D-109, D-110; services/stock.ts replayWithNew; a credit note's
// posting replays it twice, services/purchase-returns.ts postReturn), while it holds the business row
// FOR SHARE and the material's cost row FOR UPDATE (lock order of D-135). Every other posting of the
// material, and closing the books, waits for it.
//
// Before D-208, each reversal in the ledger rebuilt the book from the start over every movement still
// standing, and each receipt marked every earlier receipt as touched: a ledger of n movements with k
// reversals cost about k × n × receipts (2,190 receipts with 219 reversals: 3 s; 4,380 with 219:
// 12 s), and the time kept growing with the business's age until postings timed out.
//
// Since D-208 a reversal undoes the movements back to its target and applies the ones after it
// again: a replay costs about its movements, plus, for each reversal, the movements still standing
// after its target. So a correction posted soon after its purchase costs next to nothing, and one
// posted L purchases later costs about L. Measured on the development machine (2026-10-01; the
// three-year ledger below, one purchase in ten corrected L purchases later): L = 0, 25 ms; L = 60
// (a month), 120 ms; L = 365 (six months), 0.6 to 0.9 s; every correction at the end of the three
// years, 3 s; one purchase in a hundred corrected a year later, 0.2 s. The cost follows how late
// corrections come, not the business's age: six years with corrections a month late take 250 ms,
// twice the three. Corrections months late on every tenth purchase are not how a business works;
// were they ever to be, the engine would need checkpoints of the book (D-208 rejected them for their
// memory).
//
// The case below is an ordinary café: milk bought twice a day for three years, one purchase in ten
// corrected ("Correct" = reverse + a new draft, D-114 rule 3). The budgets leave a wide margin for a
// slower machine.

/**
 * Milk bought `purchases` times (10 L, AED 6.25 to 12.25), every `correctEvery`-th one reversed `lag`
 * purchases later (0: at once; those still due at the end are reversed there).
 */
function cafeMilk(purchases: number, correctEvery: number, lag = 0): WacMovement[] {
  const ledger: WacMovement[] = []
  const due: { at: number; receiptId: string }[] = []
  for (let i = 0; i < purchases; i++) {
    ledger.push({
      type: 'receipt',
      id: `receipt-${i}`,
      qty: '10000' as Quantity,
      value: `${60 + (i % 7)}.25` as CostAmount,
    })
    if (i % correctEvery === correctEvery - 1) due.push({ at: i + lag, receiptId: `receipt-${i}` })
    while (due.length > 0 && due[0]!.at <= i) {
      ledger.push({ type: 'receipt_reversal', receiptId: due.shift()!.receiptId })
    }
  }
  for (const { receiptId } of due) ledger.push({ type: 'receipt_reversal', receiptId })
  return ledger
}

/** Replays `ledger` and says how long it took (ms). */
function timed(ledger: WacMovement[]) {
  const started = Date.now()
  const { state } = replayWac(ledger)
  return { state, elapsed: Date.now() - started }
}

describe('the cost of a replay (what every return, credit note and reversal pays under its locks)', () => {
  it('three years of two milk purchases a day, one in ten corrected: well under a second', () => {
    const { state, elapsed } = timed(cafeMilk(2190, 10))
    // The replay itself is right (1,971 receipts stand: 19,710 L)…
    expect(state.qty).toBe('19710000')
    // …but it must not take seconds.
    expect(elapsed, `replayWac took ${elapsed} ms`).toBeLessThan(750)
  }, 60_000)

  // The budgets below catch the engine before D-208 (4.4 s, and more than 12 s), with room for a
  // machine busy with every other package's checks (pnpm check runs them at once: 0.7 s and 1.1 s
  // measured then, for 0.12 s and 0.25 s alone).

  it('the same, each correction posted a month later (60 purchases on): a fraction of the old 4.4 s', () => {
    const { state, elapsed } = timed(cafeMilk(2190, 10, 60))
    expect(state.qty).toBe('19710000')
    expect(elapsed, `replayWac took ${elapsed} ms`).toBeLessThan(1500)
  }, 60_000)

  it('six years of it, corrections a month late: the cost follows the lateness, not the age', () => {
    const { state, elapsed } = timed(cafeMilk(4380, 10, 60))
    // 3,942 receipts stand: 39,420 L.
    expect(state.qty).toBe('39420000')
    // Twice the ledger, twice the budget.
    expect(elapsed, `replayWac took ${elapsed} ms`).toBeLessThan(3000)
  }, 60_000)
})
