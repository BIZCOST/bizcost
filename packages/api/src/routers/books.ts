import { booksDto, closeBooksInput } from '@bizcost/contracts'
import { closeBooks, getBooks } from '../services/books'
import { requirePermission, router } from '../trpc'
import { purchasesModule, viewPurchases } from './purchase'

/**
 * "Books closed up to" (services/books.ts; D-114 rule 6): with the purchases module, the first that
 * posts. Reading needs purchases.documents.view; closing or opening needs purchases.books.close (the
 * Owner and Admin templates).
 */
export const booksRouter = router({
  /** `books.get`: the date and today in the business's time zone. */
  get: viewPurchases.output(booksDto).query(({ ctx }) => getBooks(ctx)),
  /** `books.close`: up to a day (today at the latest), or null to open them again. */
  close: purchasesModule
    .use(requirePermission('purchases.books.close'))
    .input(closeBooksInput)
    .output(booksDto)
    .mutation(({ ctx, input }) => closeBooks(ctx, input)),
})
