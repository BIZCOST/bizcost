import { booksDto, closeBooksInput } from '@bizcost/contracts'
import { closeBooks, getBooks } from '../services/books'
import { businessProcedure, requireAnyAccess, router } from '../trpc'

/**
 * "Books closed up to" (services/books.ts; D-114 rule 6): purchases and expenses check the same date
 * (M2 Step 5), and sales too (M3 Step 2, D-227). Reading needs purchases.documents.view or
 * expenses.documents.view, any key to see or enter sales (Today's sales says the date), or the key to
 * close them; closing or opening needs settings.books.close (the Owner and Admin templates; a Settings
 * key since M2 Step 7, D-201). Each with Purchases, Expenses or Sales on (Sales only while served), so a
 * business without Purchases can still open the books its expenses or sales obey (D-176, D-236); with
 * none, there is nothing to close (MODULE_DISABLED).
 */
export const booksRouter = router({
  /** `books.get`: the date and today in the business's time zone. */
  get: businessProcedure
    .use(
      requireAnyAccess(
        ['purchases', 'purchases.documents.view'],
        ['expenses', 'expenses.documents.view'],
        ['purchases', 'settings.books.close'],
        ['expenses', 'settings.books.close'],
        ['sales', 'sales.documents.view'],
        ['sales', 'sales.documents.manage'],
        ['sales', 'settings.books.close'],
      ),
    )
    .output(booksDto)
    .query(({ ctx }) => getBooks(ctx)),
  /** `books.close`: up to a day (today at the latest), or null to open them again. */
  close: businessProcedure
    .use(
      requireAnyAccess(
        ['purchases', 'settings.books.close'],
        ['expenses', 'settings.books.close'],
        ['sales', 'settings.books.close'],
      ),
    )
    .input(closeBooksInput)
    .output(booksDto)
    .mutation(({ ctx, input }) => closeBooks(ctx, input)),
})
