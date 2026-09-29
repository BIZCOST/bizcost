import {
  payableListDto,
  payableListInput,
  purchasePaymentsDto,
  purchasePaymentsInput,
  recordPurchasePaymentInput,
  reversePurchasePaymentInput,
  type PayableKindDto,
} from '@bizcost/contracts'
import type { BusinessCtx } from '../business-context'
import {
  listPayables,
  listPurchasePayments,
  recordPurchasePayment,
  reversePurchasePayment,
} from '../services/payments'
import {
  businessProcedure,
  passes,
  requireAnyAccess,
  requirePermission,
  router,
  type ModuleAccessPair,
} from '../trpc'
import { viewPurchases } from './purchase'

/**
 * What the business still owes on its purchases and expenses, and paying it (services/payments.ts;
 * the owner's requests of 2026-09-29, D-160; expenses from M2 Step 5, D-166). "Amounts owed" lists
 * the purchases of a member who may see their payments (module `purchases`, purchases.documents.view
 * and purchases.payments.view) and the expenses of one who may see theirs (module `expenses`,
 * expenses.documents.view and expenses.payments.view): at least one of the two (MODULE_DISABLED when
 * neither module is on, FORBIDDEN otherwise). A purchase's payments need purchases.payments.view to
 * read and purchases.payments.record to record or reverse (the Owner, Admin and Manager templates);
 * an expense's are in expense.ts. Amounts are `supplier_price` (withMeta); listing what is owed and
 * recording a payment need supplier prices visible (FORBIDDEN otherwise).
 */
const PAYABLE_ACCESS: Readonly<Record<PayableKindDto, ModuleAccessPair>> = {
  purchase: ['purchases', 'purchases.documents.view', 'purchases.payments.view'],
  expense: ['expenses', 'expenses.documents.view', 'expenses.payments.view'],
}

/** The kinds of document whose payments the member may see. */
function payableKinds(ctx: BusinessCtx): PayableKindDto[] {
  return (Object.keys(PAYABLE_ACCESS) as PayableKindDto[]).filter((kind) =>
    passes(ctx, PAYABLE_ACCESS[kind]),
  )
}

const viewPayables = businessProcedure.use(
  requireAnyAccess(PAYABLE_ACCESS.purchase, PAYABLE_ACCESS.expense),
)
const viewPayments = viewPurchases.use(requirePermission('purchases.payments.view'))
const recordPayments = viewPayments.use(requirePermission('purchases.payments.record'))

export const payableRouter = router({
  /** `payable.list`: what is still owed to suppliers, or to members, with each document. */
  list: viewPayables
    .input(payableListInput)
    .output(payableListDto)
    .query(({ ctx, input }) => listPayables(ctx, input, payableKinds(ctx))),
})

export const purchasePaymentRouter = router({
  /** `purchasePayment.list`: a purchase's payments and what is still owed on it. */
  list: viewPayments
    .input(purchasePaymentsInput)
    .output(purchasePaymentsDto)
    .query(({ ctx, input }) => listPurchasePayments(ctx, input)),
  /** `purchasePayment.record`: a payment of what is owed; idempotent on the client's id. */
  record: recordPayments
    .input(recordPurchasePaymentInput)
    .output(purchasePaymentsDto)
    .mutation(({ ctx, input }) => recordPurchasePayment(ctx, input)),
  /** `purchasePayment.reverse`: a payment recorded by mistake stops counting. Idempotent. */
  reverse: recordPayments
    .input(reversePurchasePaymentInput)
    .output(purchasePaymentsDto)
    .mutation(({ ctx, input }) => reversePurchasePayment(ctx, input)),
})
