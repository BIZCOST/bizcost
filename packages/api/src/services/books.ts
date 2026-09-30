import type { BooksDto, closeBooksInput } from '@bizcost/contracts'
import { businesses, type Tx } from '@bizcost/db'
import { eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'

// "Books closed up to" (D-114 rule 6): optional, off by default. Nothing dated on or before it can be
// posted or reversed (stock.ts checks it with the business row locked FOR SHARE, so a change here waits
// for the postings in flight). Set by the Owner or an Admin (settings.books.close, a Settings key since
// M2 Step 7, D-201). Moving it back is allowed; every change is audited (the audit trigger on
// businesses). It is never after today in the business's time zone.

type CloseInput = z.output<typeof closeBooksInput>

async function readBooks(tx: Tx, businessId: string): Promise<BooksDto> {
  const [row] = (await tx.execute(sql`
    select b.books_closed_through::text as closed_through,
           (now() at time zone b.timezone)::date::text as today
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as { closed_through: string | null; today: string }[]
  if (!row) throw new AppError('forbidden')
  return { closedThrough: row.closed_through, today: row.today }
}

/**
 * `books.get` (purchases or expenses "see", or settings.books.close): the date, and today in the
 * business's time zone.
 */
export function getBooks(ctx: BusinessCtx): Promise<BooksDto> {
  return ctx.tx((tx) => readBooks(tx, ctx.businessId))
}

/**
 * `books.close` (settings.books.close): closes the books up to a day (today at the latest,
 * FUTURE_DATE otherwise), or opens them again (null).
 */
export function closeBooks(ctx: BusinessCtx, input: CloseInput): Promise<BooksDto> {
  return ctx.tx(async (tx) => {
    const { today } = await readBooks(tx, ctx.businessId)
    if (input.closedThrough !== null && input.closedThrough > today) {
      throw new AppError('future_date')
    }
    await tx
      .update(businesses)
      .set({ booksClosedThrough: input.closedThrough })
      .where(eq(businesses.id, ctx.businessId))
    return readBooks(tx, ctx.businessId)
  })
}
