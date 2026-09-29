import { booksDto, closeBooksInput } from '@bizcost/contracts'
import { closeBooks, getBooks } from '../services/books'
import { businessProcedure, requireAnyAccess, router } from '../trpc'

/**
 * "Books closed up to" (services/books.ts; D-114 rule 6): purchases and expenses check the same date
 * (M2 Step 5). Reading needs purchases.documents.view or expenses.documents.view (each with its module
 * on); closing or opening needs purchases.books.close (the Owner and Admin templates) with Purchases or
 * Expenses on, so a business without Purchases can still open the books its expenses obey (D-176;
 * Step 7 moves the key to Settings).
 */
export const booksRouter = router({
  /** `books.get`: the date and today in the business's time zone. */
  get: businessProcedure
    .use(
      requireAnyAccess(
        ['purchases', 'purchases.documents.view'],
        ['expenses', 'expenses.documents.view'],
      ),
    )
    .output(booksDto)
    .query(({ ctx }) => getBooks(ctx)),
  /** `books.close`: up to a day (today at the latest), or null to open them again. */
  close: businessProcedure
    .use(
      requireAnyAccess(
        ['purchases', 'purchases.books.close'],
        ['expenses', 'purchases.books.close'],
      ),
    )
    .input(closeBooksInput)
    .output(booksDto)
    .mutation(({ ctx, input }) => closeBooks(ctx, input)),
})
