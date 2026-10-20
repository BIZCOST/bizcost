import {
  createInvoiceInput,
  depositsWithoutInvoiceDto,
  documentPdfDto,
  invoiceCopyToQuotationInput,
  invoiceDto,
  invoiceFromOrderInput,
  invoiceFromQuotationInput,
  invoiceFromSaleInput,
  invoiceHistoryDto,
  invoiceIdInput,
  invoiceListDto,
  invoiceListInput,
  invoiceVersionInput,
  okDto,
  quotationDto,
  updateInvoiceInput,
} from '@bizcost/contracts'
import { z } from 'zod'
import { invoicePdf, issueInvoiceWithPdf } from '../services/invoice-pdf'
import {
  copyInvoiceToQuotation,
  createInvoice,
  depositsWithoutInvoice,
  discardInvoice,
  getInvoice,
  invoiceFromOrder,
  invoiceFromQuotation,
  invoiceFromSale,
  invoiceHistory,
  listInvoices,
  updateInvoice,
} from '../services/invoices'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Invoices (services/invoices.ts, services/invoice-pdf.ts; M3 Step 8, planned until Release B: served
 * only under the dev-only preview, D-125): module `invoices`. `invoices.documents.view` reads them,
 * their history and their PDFs; `.manage` prepares drafts (from scratch, an accepted quotation, an
 * order or a recorded sale, each also needing its own module and keys, which the service checks) and
 * copies an invoice to a quotation; `.issue` issues one (its number is taken, it is frozen). Prices are
 * not sensitive (D-187); what an invoice is paid and owes shows with payments.customers.view.
 */
const invoicesModule = businessProcedure.use(requireModule('invoices'))
const view = invoicesModule.use(requirePermission('invoices.documents.view'))
const manage = view.use(requirePermission('invoices.documents.manage'))
const issue = view.use(requirePermission('invoices.documents.issue'))

export const invoiceRouter = router({
  /** `invoice.list`: drafts first, then issued ones by number; status, customer, order, search. */
  list: view
    .input(invoiceListInput)
    .output(invoiceListDto)
    .query(({ ctx, input }) => listInvoices(ctx, input)),
  /** `invoice.get`: its lines, credit notes, what it is paid and owes, what would stop its issue. */
  get: view
    .input(invoiceIdInput)
    .output(invoiceDto)
    .query(({ ctx, input }) => getInvoice(ctx, input)),
  /** `invoice.history`: what happened to it, who and when. */
  history: view
    .input(invoiceIdInput)
    .output(invoiceHistoryDto)
    .query(({ ctx, input }) => invoiceHistory(ctx, input)),
  /** `invoice.pdf`: the issued PDF (stored), or a draft's marked as a draft (rate-limited). */
  pdf: view
    .input(invoiceIdInput)
    .output(documentPdfDto)
    .mutation(({ ctx, input }) => invoicePdf(ctx, input)),
  /** `invoice.depositsWithoutInvoice`: deposits on orders that no deposit tax invoice covers yet. */
  depositsWithoutInvoice: view
    .input(z.object({}).prefault({}))
    .output(depositsWithoutInvoiceDto)
    .query(({ ctx }) => depositsWithoutInvoice(ctx)),
  /** `invoice.create`: a draft from scratch, idempotent on the client's id. */
  create: manage
    .input(createInvoiceInput)
    .output(invoiceDto)
    .mutation(({ ctx, input }) => createInvoice(ctx, input)),
  /** `invoice.update`: a draft, `version` as read. */
  update: manage
    .input(updateInvoiceInput)
    .output(invoiceDto)
    .mutation(({ ctx, input }) => updateInvoice(ctx, input)),
  /** `invoice.discard`: a draft (it never had a number). */
  discard: manage
    .input(invoiceVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardInvoice(ctx, input)),
  /** `invoice.fromQuotation`: a draft billing an accepted quotation (everything, a part, the rest). */
  fromQuotation: manage
    .input(invoiceFromQuotationInput)
    .output(invoiceDto)
    .mutation(({ ctx, input }) => invoiceFromQuotation(ctx, input)),
  /** `invoice.fromOrder`: a draft billing an order (everything, a part or a deposit, the rest). */
  fromOrder: manage
    .input(invoiceFromOrderInput)
    .output(invoiceDto)
    .mutation(({ ctx, input }) => invoiceFromOrder(ctx, input)),
  /** `invoice.fromSale`: a draft billing a recorded One sale. */
  fromSale: manage
    .input(invoiceFromSaleInput)
    .output(invoiceDto)
    .mutation(({ ctx, input }) => invoiceFromSale(ctx, input)),
  /** `invoice.copyToQuotation`: a new quotation draft with its customer and lines. */
  copyToQuotation: manage
    .input(invoiceCopyToQuotationInput)
    .output(quotationDto)
    .mutation(({ ctx, input }) => copyInvoiceToQuotation(ctx, input)),
  /** `invoice.issue`: the gapless number taken, frozen, its sale posted when it counts. Idempotent. */
  issue: issue
    .input(invoiceVersionInput)
    .output(invoiceDto)
    .mutation(({ ctx, input }) => issueInvoiceWithPdf(ctx, input)),
})
