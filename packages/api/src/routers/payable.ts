import {
  payableListDto,
  payableListInput,
  purchasePaymentsDto,
  purchasePaymentsInput,
  recordPurchasePaymentInput,
  reversePurchasePaymentInput,
} from '@bizcost/contracts'
import {
  listPayables,
  listPurchasePayments,
  recordPurchasePayment,
  reversePurchasePayment,
} from '../services/purchase-payments'
import { requirePermission, router } from '../trpc'
import { viewPurchases } from './purchase'

/**
 * What the business still owes on its purchases, and paying it (services/purchase-payments.ts; the
 * owner's requests of 2026-09-29): module `purchases` and purchases.documents.view, then
 * purchases.payments.view to read and purchases.payments.record to record or reverse a payment (the
 * Owner, Admin and Manager templates). Amounts are `supplier_price` (withMeta); listing what is owed
 * and recording a payment need supplier prices visible (FORBIDDEN otherwise).
 */
const viewPayments = viewPurchases.use(requirePermission('purchases.payments.view'))
const recordPayments = viewPayments.use(requirePermission('purchases.payments.record'))

export const payableRouter = router({
  /** `payable.list`: what is still owed to suppliers, or to members, with each purchase. */
  list: viewPayments
    .input(payableListInput)
    .output(payableListDto)
    .query(({ ctx, input }) => listPayables(ctx, input)),
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
