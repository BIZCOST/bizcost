import {
  createCreditNoteInput,
  creditNoteDto,
  creditNoteHistoryDto,
  creditNoteIdInput,
  creditNoteListDto,
  creditNoteListInput,
  creditNoteVersionInput,
  documentPdfDto,
  okDto,
  updateCreditNoteInput,
} from '@bizcost/contracts'
import {
  createCreditNote,
  creditNoteHistory,
  discardCreditNote,
  getCreditNote,
  listCreditNotes,
  updateCreditNote,
} from '../services/credit-notes'
import { creditNotePdf, issueCreditNoteWithPdf } from '../services/invoice-pdf'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Credit notes (services/credit-notes.ts; M3 Step 8, with Invoices): module `invoices`.
 * `invoices.documents.view` reads them and their PDFs; `.credit` prepares, discards and issues them
 * (their own gapless series, CN-0001…). Only a credit note corrects an issued invoice.
 */
const invoicesModule = businessProcedure.use(requireModule('invoices'))
const view = invoicesModule.use(requirePermission('invoices.documents.view'))
const credit = view.use(requirePermission('invoices.documents.credit'))

export const creditNoteRouter = router({
  /** `creditNote.list`: drafts first, then issued ones by number; by invoice, customer, search. */
  list: view
    .input(creditNoteListInput)
    .output(creditNoteListDto)
    .query(({ ctx, input }) => listCreditNotes(ctx, input)),
  /** `creditNote.get`: its lines, reason and the values of ER Art. 60(1)(e). */
  get: view
    .input(creditNoteIdInput)
    .output(creditNoteDto)
    .query(({ ctx, input }) => getCreditNote(ctx, input)),
  /** `creditNote.history`: what happened to it, who and when. */
  history: view
    .input(creditNoteIdInput)
    .output(creditNoteHistoryDto)
    .query(({ ctx, input }) => creditNoteHistory(ctx, input)),
  /** `creditNote.pdf`: the issued PDF (stored), or a draft's marked as a draft (rate-limited). */
  pdf: view
    .input(creditNoteIdInput)
    .output(documentPdfDto)
    .mutation(({ ctx, input }) => creditNotePdf(ctx, input)),
  /** `creditNote.create`: a draft of an issued invoice, idempotent on the client's id. */
  create: credit
    .input(createCreditNoteInput)
    .output(creditNoteDto)
    .mutation(({ ctx, input }) => createCreditNote(ctx, input)),
  /** `creditNote.update`: a draft, `version` as read. */
  update: credit
    .input(updateCreditNoteInput)
    .output(creditNoteDto)
    .mutation(({ ctx, input }) => updateCreditNote(ctx, input)),
  /** `creditNote.discard`: a draft (it never had a number). */
  discard: credit
    .input(creditNoteVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardCreditNote(ctx, input)),
  /** `creditNote.issue`: its gapless number taken, frozen, its negative sale posted. Idempotent. */
  issue: credit
    .input(creditNoteVersionInput)
    .output(creditNoteDto)
    .mutation(({ ctx, input }) => issueCreditNoteWithPdf(ctx, input)),
})
