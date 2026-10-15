import {
  customerPaymentListDto,
  customerPaymentListInput,
  documentPaymentsDto,
  receivableListDto,
  receivableListInput,
  recordCustomerPaymentInput,
  recordManyCustomerPaymentsDto,
  recordManyCustomerPaymentsInput,
  reverseCustomerPaymentInput,
} from '@bizcost/contracts'
import {
  listCustomerPayments,
  recordCustomerPayment,
  recordManyCustomerPayments,
  reverseCustomerPayment,
} from '../services/payments'
import { listReceivables } from '../services/receivables'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Customer payments and What customers owe (services/payments.ts, services/receivables.ts; M3 Step
 * 5): module `payments` (planned until Release A, so served only under the dev-only preview, D-125).
 * payments.customers.view lists payments and what customers owe (it needs every sale seen, H1);
 * payments.customers.record records and reverses them, one or several at once. Their amounts are
 * sales amounts, not a redaction category.
 */
const paymentsModule = businessProcedure.use(requireModule('payments'))
const viewPayments = paymentsModule.use(requirePermission('payments.customers.view'))
const recordPayments = paymentsModule.use(requirePermission('payments.customers.record'))

export const customerPaymentRouter = router({
  /** `customerPayment.list`: an order's or a sale's payments with what it is owed, or a customer's. */
  list: viewPayments
    .input(customerPaymentListInput)
    .output(customerPaymentListDto)
    .query(({ ctx, input }) => listCustomerPayments(ctx, input)),
  /** `customerPayment.record`: a payment or money given back; idempotent on the client's id. */
  record: recordPayments
    .input(recordCustomerPaymentInput)
    .output(documentPaymentsDto)
    .mutation(({ ctx, input }) => recordCustomerPayment(ctx, input)),
  /** `customerPayment.reverse`: a payment recorded by mistake stops counting. Idempotent. */
  reverse: recordPayments
    .input(reverseCustomerPaymentInput)
    .output(documentPaymentsDto)
    .mutation(({ ctx, input }) => reverseCustomerPayment(ctx, input)),
  /** `customerPayment.recordMany`: "Pay several at once", one payment each (M14). */
  recordMany: recordPayments
    .input(recordManyCustomerPaymentsInput)
    .output(recordManyCustomerPaymentsDto)
    .mutation(({ ctx, input }) => recordManyCustomerPayments(ctx, input)),
})

export const receivableRouter = router({
  /** `receivable.list`: "What customers owe", by customer; one figure per obligation (A2). */
  list: viewPayments
    .input(receivableListInput)
    .output(receivableListDto)
    .query(({ ctx, input }) => listReceivables(ctx, input)),
})
