import { compareDecimal, subtractDecimals, sumDecimals } from '@bizcost/domain'

// "Pay several at once" (M3 Step 5; Q17, M14, D-267): one amount of one customer applied to their
// open orders and sales in the order chosen (oldest first), each up to what it still owes; a document
// the amount does not reach gets nothing. customerPayment.recordMany applies it the same way on the
// server; the sheet shows it before it is recorded.

export interface OwedPart {
  /** What the document still owes (more than zero). */
  readonly owed: string
}

/** What `amount` pays of each document, in their order (exact; '0' where it does not reach). */
export function allocate(amount: string, documents: readonly OwedPart[]): string[] {
  let left = amount
  return documents.map((document) => {
    if (compareDecimal(left, '0') <= 0) return '0'
    const paid = compareDecimal(left, document.owed) >= 0 ? document.owed : left
    left = subtractDecimals(left, paid)
    return paid
  })
}

/** What the documents owe in all. */
export function owedIn(documents: readonly OwedPart[]): string {
  return sumDecimals(documents.map((document) => document.owed))
}
