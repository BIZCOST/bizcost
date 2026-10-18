import {
  acceptQuotationInput,
  copyQuotationInput,
  createQuotationInput,
  declineQuotationInput,
  documentPdfDto,
  okDto,
  quotationDto,
  quotationHistoryDto,
  quotationIdInput,
  quotationListDto,
  quotationListInput,
  quotationOrderDto,
  quotationToOrderInput,
  quotationVersionInput,
  reviseQuotationInput,
  updateQuotationInput,
} from '@bizcost/contracts'
import { quotationPdf } from '../services/quotation-pdf'
import {
  acceptQuotation,
  copyQuotation,
  createQuotation,
  declineQuotation,
  discardQuotation,
  getQuotation,
  listQuotations,
  quotationHistory,
  quotationToOrder,
  reviseQuotation,
  sendQuotation,
  updateQuotation,
} from '../services/quotations'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Quotations (services/quotations.ts; M3 Step 7, planned until Release B: served only under the
 * dev-only preview, D-125): module `quotations`. `quotations.documents.view` reads them, their history
 * and their PDFs; `.manage` prepares, sends, revises, copies and discards them and makes an order of an
 * accepted one (with Orders on and orders.documents.manage, which the service checks); `.decide`
 * records the customer's answer. Prices are not sensitive (D-187): nothing is redacted.
 */
const quotationsModule = businessProcedure.use(requireModule('quotations'))
const view = quotationsModule.use(requirePermission('quotations.documents.view'))
const manage = view.use(requirePermission('quotations.documents.manage'))
const decide = view.use(requirePermission('quotations.documents.decide'))

export const quotationRouter = router({
  /** `quotation.list`: the latest revision of each, newest first, by status and search. */
  list: view
    .input(quotationListInput)
    .output(quotationListDto)
    .query(({ ctx, input }) => listQuotations(ctx, input)),
  /** `quotation.get`: a revision with its lines, pictures, stages and the other revisions. */
  get: view
    .input(quotationIdInput)
    .output(quotationDto)
    .query(({ ctx, input }) => getQuotation(ctx, input)),
  /** `quotation.history`: what happened to its revisions, who and when. */
  history: view
    .input(quotationIdInput)
    .output(quotationHistoryDto)
    .query(({ ctx, input }) => quotationHistory(ctx, input)),
  /** `quotation.pdf`: the revision's PDF on the business's letterhead (rate-limited). */
  pdf: view
    .input(quotationIdInput)
    .output(documentPdfDto)
    .mutation(({ ctx, input }) => quotationPdf(ctx, input)),
  /** `quotation.create`: a draft numbered Q-0001…, idempotent on the client's id. */
  create: manage
    .input(createQuotationInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => createQuotation(ctx, input)),
  /** `quotation.update`: a draft, whole, `version` as read. */
  update: manage
    .input(updateQuotationInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => updateQuotation(ctx, input)),
  /** `quotation.discard`: a draft (its number is not given back). */
  discard: manage
    .input(quotationVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardQuotation(ctx, input)),
  /** `quotation.send`: the draft is frozen as sent. Idempotent. */
  send: manage
    .input(quotationVersionInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => sendQuotation(ctx, input)),
  /** `quotation.revise`: a new draft revision under the same number. Idempotent on `newId`. */
  revise: manage
    .input(reviseQuotationInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => reviseQuotation(ctx, input)),
  /** `quotation.copy`: a new quotation from any revision. Idempotent on `newId`. */
  copy: manage
    .input(copyQuotationInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => copyQuotation(ctx, input)),
  /** `quotation.toOrder`: a pending order from an accepted revision, once. */
  toOrder: manage
    .input(quotationToOrderInput)
    .output(quotationOrderDto)
    .mutation(({ ctx, input }) => quotationToOrder(ctx, input)),
  /** `quotation.accept`: the customer accepted the sent revision. Idempotent. */
  accept: decide
    .input(acceptQuotationInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => acceptQuotation(ctx, input)),
  /** `quotation.decline`: the customer declined the sent revision. Idempotent. */
  decline: decide
    .input(declineQuotationInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => declineQuotation(ctx, input)),
})
