import { booksDto, closeBooksInput } from '@bizcost/contracts'
import { closeBooks, getBooks } from '../services/books'
import { businessProcedure, requireAnyAccess, router } from '../trpc'

/**
 * "Books closed up to" (services/books.ts; D-114 rule 6): purchases and expenses check the same date
 * (M2 Step 5), sales too (M3 Step 2, D-227), and orders' deliveries and refunds and what customers pay
 * (M3 Step 5). Reading needs a key that sees or enters any of them (the screens say the date and
 * today), or the key to close them; closing or opening needs settings.books.close (the Owner and Admin
 * templates; a Settings key since M2 Step 7, D-201). Each with its module on (Purchases, Expenses,
 * Sales, Orders or Payments), so a business without Purchases can still open the books its expenses
 * or sales obey (D-176, D-236); with none, there is nothing to close (MODULE_DISABLED).
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
        ['orders', 'orders.documents.view'],
        ['orders', 'orders.documents.manage'],
        ['orders', 'orders.documents.deliver'],
        ['orders', 'settings.books.close'],
        ['payments', 'payments.customers.view'],
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
        ['orders', 'settings.books.close'],
      ),
    )
    .input(closeBooksInput)
    .output(booksDto)
    .mutation(({ ctx, input }) => closeBooks(ctx, input)),
})
