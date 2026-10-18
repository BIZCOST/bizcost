import type { Tx } from '@bizcost/db'
import {
  DOCUMENT_COUNTER_DEFAULTS,
  documentNumber,
  newId,
  type DocumentSeries,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { AppError } from '../errors'

// Document numbers (ROADMAP.md M3 Step 5; the plan's numbering design, H9; Q25 of D-218): one counter
// row per business and series (`document_counters`). Taking a number:
//
//   - is the LAST lock of the transaction that creates the document (after every row it reads, any
//     cost rows included): an UPDATE … RETURNING of the counter row, which locks it FOR UPDATE until
//     the transaction ends. Nothing else locks a counter row, so it cannot be part of a deadlock, and
//     it never waits behind anything but another create of the same series;
//   - happens only after a replayed create was answered from the document it made (the caller checks
//     its id first), so a replay never takes a number;
//   - is given back by a rollback (the counter's update rolls back with the document).
//
// The document stores its number as printed and its integer (UNIQUE per business and series), so a
// prefix edited later renumbers nothing. Order numbers may skip (a failed create after its number is
// rolled back, but the series does not promise more); invoices (Step 8) use the same design gaplessly.

/** The next number of `series` for the business, taken under the counter row's lock. */
export async function takeNumber(
  tx: Tx,
  businessId: string,
  series: DocumentSeries,
): Promise<{ seq: number; number: string }> {
  const defaults = DOCUMENT_COUNTER_DEFAULTS[series]
  // A business's first document of the series makes its counter (two first creates wait for each
  // other on the unique key; the second inserts nothing).
  await tx.execute(sql`
    insert into app.document_counters (id, business_id, series, next_no, first_no, prefix, padding)
    values (${newId()}, ${businessId}, ${series}, ${defaults.first}, ${defaults.first},
            ${defaults.prefix}, ${defaults.padding})
    on conflict (business_id, series) do nothing
  `)
  const [row] = (await tx.execute(sql`
    update app.document_counters c
       set next_no = c.next_no + 1
     where c.business_id = ${businessId} and c.series = ${series} and c.deleted_at is null
    returning c.next_no - 1 as seq, c.prefix, c.padding
  `)) as unknown as { seq: number; prefix: string; padding: number }[]
  if (!row) throw new AppError('internal', { message: `no ${series} counter` })
  return { seq: row.seq, number: documentNumber(row.prefix, row.seq, row.padding) }
}
