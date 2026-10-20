import type {
  CreditNoteDto,
  DocumentPdfDto,
  invoiceIdInput,
  InvoiceDto,
  invoiceVersionInput,
} from '@bizcost/contracts'
import { creditNotes, documentRenders, invoices, type Tx } from '@bizcost/db'
import {
  compareDecimal,
  newId,
  subtractDecimals,
  sumDecimals,
  type Emirate,
  type SettlementMethod,
} from '@bizcost/domain'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import {
  buildCreditNotePdfInput,
  buildInvoicePdfInput,
  type PdfBusiness,
  type PdfPayment,
} from '../documents/pdf/build'
import type { DocumentPdfImage } from '../documents/pdf/input'
import {
  creditNoteHeadOf,
  creditNoteLinesOf,
  issueCreditNote,
  valuesOf,
  type CreditNoteRecord,
} from './credit-notes'
import {
  readStoredDocumentPdf,
  removeStoredDocumentPdf,
  renderDocumentPdf,
  storeDocumentPdf,
  type PrintableImage,
} from './document-files'
import {
  invoiceHeadOf,
  invoiceLinesOf,
  issueInvoice,
  letterheadNow,
  type InvoiceRecord,
} from './invoices'
import { seesCustomers } from './customers'
import { pdfPageCount } from './quotation-pdf'
import { readObligation } from './receivables'
import { seesPayments } from './sales'

// The PDFs of invoices and credit notes (ROADMAP.md M3 Step 8; D-224, D-288–D-300), on the same
// letterhead system as a quotation's (the owner liked it, 2026-10-18): each business's own names, logo,
// accent, contact lines, signatory, signature and stamp. An issued document's PDF is rendered from its
// frozen values (its particulars, the customer's phone, and the letterhead as it was at issue, whose
// images are kept while an issued document names them) right after the issue commits, and stored in
// `business-files` (`pdf_upload_id`); `.pdf` then hands back that stored copy. When the first render
// failed (or its object is gone) the next `.pdf` renders it again from the same frozen values (its
// payments as they stood at its issue, read to the microsecond), so it comes out the same, and stores
// it; a Storage that fails is an error to retry, never a copy made without what it could not read. An
// invoice's payments print only for a member who sees payments (D-306): another gets it made without
// them (not stored). A draft's PDF is made on request from the draft as it is, marked as a draft, never
// stored, and names the customer's particulars only for a member who sees customers (D-263). Every PDF
// handed out is counted first (document_renders: at most 300 a business an hour, 20 a member a minute).

type IdInput = z.output<typeof invoiceIdInput>
type VersionInput = z.output<typeof invoiceVersionInput>

/** The frozen letterhead of an issued document (letterheadNow's columns), or the business as it is. */
interface LetterheadRow {
  legal_name: string
  legal_name_ar: string | null
  default_locale: string
  vat_registered: boolean
  trn: string | null
  phone: string | null
  phone_2: string | null
  email: string | null
  address_line: string | null
  city: string | null
  emirate: Emirate | null
  trade_licence_no: string | null
  document_accent: string
  document_watermark: boolean
  document_whole_amounts: boolean
  document_signatory: string | null
  document_footer: string | null
  logo_path: string | null
  document_signature_path: string | null
  document_stamp_path: string | null
}

/** The seller's frozen particulars (a document's own columns win over its letterhead's). */
interface SellerSnapshot {
  readonly seller_name: string | null
  readonly seller_name_ar: string | null
  readonly seller_trn: string | null
  readonly seller_trade_licence: string | null
  readonly seller_address_line: string | null
  readonly seller_city: string | null
  readonly seller_emirate: Emirate | null
}

function pdfBusinessOf(
  row: LetterheadRow,
  seller: SellerSnapshot | null,
  tax: boolean,
): PdfBusiness {
  return {
    legalName: seller?.seller_name ?? row.legal_name,
    legalNameAr: seller ? seller.seller_name_ar : row.legal_name_ar,
    locale: row.default_locale === 'ar' ? 'ar' : 'en',
    vatRegistered: tax,
    trn: seller ? seller.seller_trn : row.trn,
    phone: row.phone,
    phone2: row.phone_2,
    email: row.email,
    addressLine: seller ? seller.seller_address_line : row.address_line,
    city: seller ? seller.seller_city : row.city,
    emirate: seller ? seller.seller_emirate : row.emirate,
    tradeLicenceNo: seller ? seller.seller_trade_licence : row.trade_licence_no,
    accent: row.document_accent,
    watermark: row.document_watermark,
    wholeAmounts: row.document_whole_amounts,
    signatory: row.document_signatory,
    footer: row.document_footer,
  }
}

/** The images a document prints (only the business's own objects, document-files.ts checks each). */
function wantedImages(
  row: LetterheadRow,
  linePictures: readonly (string | null)[],
): PrintableImage[] {
  const wanted: PrintableImage[] = []
  if (row.logo_path) wanted.push({ key: 'logo', path: row.logo_path })
  if (row.document_signature_path)
    wanted.push({ key: 'signature', path: row.document_signature_path })
  if (row.document_stamp_path) wanted.push({ key: 'stamp', path: row.document_stamp_path })
  linePictures.forEach((path, i) => {
    if (path) wanted.push({ key: `line-${i + 1}`, path })
  })
  return wanted
}

const businessImagesOf = (row: LetterheadRow) => ({
  logo: row.logo_path ? 'logo' : null,
  signature: row.document_signature_path ? 'signature' : null,
  stamp: row.document_stamp_path ? 'stamp' : null,
})

const asDate = (value: Date | string | null, fallback: Date) =>
  value === null ? fallback : value instanceof Date ? value : new Date(value)

/** A document's file name: its number (characters a file name keeps), and "-draft" for a draft. */
function fileNameOf(number: string | null, draft: boolean, fallback: string): string {
  const safe =
    (number ?? fallback).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback
  return `${safe}${draft ? '-draft' : ''}.pdf`
}

function pdfDto(pdf: Uint8Array, fileName: string): DocumentPdfDto {
  return {
    fileName,
    contentType: 'application/pdf',
    base64: Buffer.from(pdf).toString('base64'),
    pages: pdfPageCount(pdf),
    bytes: pdf.byteLength,
  }
}

// ---------------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------------

/** What an invoice's PDF is made from, read in one transaction. */
async function invoiceSource(tx: Tx, ctx: BusinessCtx, head: InvoiceRecord) {
  const lines = await invoiceLinesOf(tx, ctx.businessId, head.id)
  const issued = head.status === 'issued'
  const letterhead = (issued && head.letterhead
    ? head.letterhead
    : await letterheadNow(tx, ctx.businessId)) as unknown as LetterheadRow
  // Postgres's own text of its issue time (to the microsecond: a JS Date keeps milliseconds only, and
  // the invoice would not be issued yet at that instant).
  const asOf = issued
    ? (head.issued_at_text ?? asDate(head.issued_at, new Date()).toISOString())
    : null
  // What it had been paid (as it stood at its issue): its own payments, and what its order or sale
  // paid toward it (one row, "Paid before this invoice").
  const own = (await tx.execute(sql`
    select p.business_date::text as business_date, p.method, p.note,
           trim_scale(p.amount)::text as amount
      from app.customer_payments p
     where p.business_id = ${ctx.businessId} and p.invoice_id = ${head.id} and p.kind = 'payment'
       and p.deleted_at is null
       and ${
         asOf === null
           ? sql`p.reversed_at is null`
           : sql`p.created_at <= ${asOf}::timestamptz
                   and (p.reversed_at is null or p.reversed_at > ${asOf}::timestamptz)`
       }
     order by p.business_date, p.created_at, p.id
  `)) as unknown as {
    business_date: string
    method: SettlementMethod
    note: string | null
    amount: string
  }[]
  const payments: PdfPayment[] = own.map((p) => ({
    date: p.business_date,
    method: p.method,
    reference: p.note,
    amount: p.amount,
  }))
  if (issued) {
    const obligation = await readObligation(tx, ctx.businessId, 'invoice', head.id, asOf)
    if (obligation) {
      // What its order or sale paid toward it, never more than it asks less what was paid on it.
      const ownPaid = sumDecimals(own.map((p) => p.amount))
      const paidBeyond = subtractDecimals(obligation.paid, ownPaid)
      const room = subtractDecimals(head.payable, obligation.credited, ownPaid)
      const earlier = compareDecimal(paidBeyond, room) > 0 ? room : paidBeyond
      if (compareDecimal(earlier, '0') > 0) {
        payments.unshift({
          date: head.issue_date ?? head.today,
          method: 'paidEarlier',
          reference: head.order_number,
          amount: earlier,
        })
      }
    }
  }
  return { lines, letterhead, payments }
}

async function renderInvoice(
  ctx: BusinessCtx,
  head: InvoiceRecord,
  source: Awaited<ReturnType<typeof invoiceSource>>,
  options: { readonly withPayments: boolean } = { withPayments: true },
): Promise<Uint8Array> {
  const { lines, letterhead } = source
  const payments = options.withPayments ? source.payments : []
  const issued = head.status === 'issued'
  const sees = seesCustomers(ctx)
  const tax = head.kind === 'tax_invoice'
  const wanted = wantedImages(
    letterhead,
    lines.map((l) => l.picture_path),
  )
  const customer = issued
    ? {
        name: head.customer_name ?? head.live_name,
        phone: head.customer_phone,
        trn: head.customer_trn,
        addressLine: head.customer_address_line,
        city: head.customer_city,
        emirate: head.customer_emirate,
        site: head.site,
      }
    : {
        name: head.live_name,
        phone: sees ? head.live_phone : null,
        trn: sees ? head.live_trn : null,
        addressLine: sees ? head.live_address : null,
        city: sees ? head.live_city : null,
        emirate: sees ? head.live_emirate : null,
        site: head.site,
      }
  const issueDate = head.issue_date ?? head.today
  const make = (images: Readonly<Record<string, DocumentPdfImage>>) =>
    buildInvoicePdfInput({
      business: pdfBusinessOf(letterhead, issued ? head : null, tax),
      invoice: {
        kind: head.kind,
        number: head.number,
        draft: !issued,
        issueDate,
        supplyDate: head.supply_date ?? issueDate,
        dueDate: head.due_date,
        lpo: head.lpo_reference,
        quotationNumber: head.quotation_number,
        orderNumber: head.order_number,
        currency: head.currency,
        vatRegistered: head.vat_registered,
        subtotal: head.subtotal,
        discountTotal: head.discount_total,
        adjustment: head.adjustment,
        roundingDifference: head.rounding_difference,
        netTotal: head.net_total,
        vatTotal: head.vat_total,
        total: head.total,
        payable: head.payable,
        vatRates: head.vat_rates,
        terms: head.terms,
        notes: head.notes,
        issuedAt: asDate(head.issued_at, asDate(head.updated_at, new Date())),
        lines: lines.map((line, i) => ({
          kind: line.kind,
          area: line.area,
          title: line.description,
          details: line.details,
          note: line.note,
          qty: line.qty,
          unit: line.unit,
          unitPrice: line.unit_price,
          subtotal: line.subtotal,
          lineDiscount: line.discount,
          priceIncludesVat: line.price_includes_vat,
          vatCategory: line.vat_category,
          vatRate: line.vat_rate,
          picture: line.picture_path ? `line-${i + 1}` : null,
        })),
        payments,
      },
      customer: { ...customer, showTrn: tax },
      businessImages: businessImagesOf(letterhead),
      images,
    })
  return renderDocumentPdf(ctx, wanted, make, { strict: issued })
}

/**
 * Renders an issued invoice's PDF from its frozen values and stores it, linking it once (a render that
 * lost the race to link removes its own copy). Returns the PDF.
 */
async function renderAndStoreInvoice(ctx: BusinessCtx, id: string): Promise<Uint8Array> {
  const { head, source } = await ctx.tx(async (tx) => {
    const head = await invoiceHeadOf(tx, ctx, id)
    return { head, source: await invoiceSource(tx, ctx, head) }
  })
  const pdf = await renderInvoice(ctx, head, source)
  if (head.status !== 'issued') return pdf
  const stored = await storeDocumentPdf(ctx, pdf)
  const linked = await ctx.tx(async (tx) => {
    const rows = await tx
      .update(invoices)
      .set({ pdfUploadId: stored.id })
      .where(
        and(
          eq(invoices.businessId, ctx.businessId),
          eq(invoices.id, id),
          isNull(invoices.pdfUploadId),
        ),
      )
      .returning({ id: invoices.id })
    return rows.length > 0
  })
  if (!linked) await removeStoredDocumentPdf(ctx, stored.path)
  return pdf
}

/**
 * `invoice.issue` with its PDF: the issue commits (issueInvoice), then its PDF is rendered and stored.
 * A failed render leaves the invoice issued without its stored PDF (reported); `invoice.pdf` makes it
 * again.
 */
export async function issueInvoiceWithPdf(
  ctx: BusinessCtx,
  input: VersionInput,
): Promise<InvoiceDto> {
  const issued = await issueInvoice(ctx, input)
  if (issued.status === 'issued' && !issued.pdfStored) {
    try {
      await renderAndStoreInvoice(ctx, issued.id)
      return { ...issued, pdfStored: true }
    } catch (error) {
      ctx.reportError(error)
    }
  }
  return issued
}

/**
 * `invoice.pdf` (invoices.documents.view): an issued invoice's stored PDF (rendered again and stored
 * when it is missing), or a draft's made now and marked as a draft. Counted first (RATE_LIMITED).
 */
export async function invoicePdf(ctx: BusinessCtx, input: IdInput): Promise<DocumentPdfDto> {
  const head = await ctx.tx(async (tx) => {
    const head = await invoiceHeadOf(tx, ctx, input.id)
    await tx.insert(documentRenders).values({
      id: newId(),
      businessId: ctx.businessId,
      kind: 'invoice',
      documentId: head.id,
    })
    return head
  })
  const fileName = fileNameOf(head.number, head.status === 'draft', 'invoice')
  if (head.status === 'issued' && !seesPayments(ctx)) {
    // What it was paid prints for a member who sees payments only (D-306): made without it.
    const source = await ctx.tx((tx) => invoiceSource(tx, ctx, head))
    if (source.payments.length > 0) {
      return pdfDto(await renderInvoice(ctx, head, source, { withPayments: false }), fileName)
    }
  }
  if (head.status === 'issued' && head.pdf_upload_id !== null) {
    const path = await ctx.tx(async (tx) => storedPath(tx, ctx.businessId, head.pdf_upload_id!))
    const stored = path ? await readStoredDocumentPdf(ctx, path) : null
    if (stored) return pdfDto(stored, fileName)
    // The stored copy is gone: made again from the same frozen values.
    const source = await ctx.tx((tx) => invoiceSource(tx, ctx, head))
    return pdfDto(await renderInvoice(ctx, head, source), fileName)
  }
  if (head.status === 'issued') return pdfDto(await renderAndStoreInvoice(ctx, head.id), fileName)
  const source = await ctx.tx((tx) => invoiceSource(tx, ctx, head))
  return pdfDto(await renderInvoice(ctx, head, source), fileName)
}

async function storedPath(tx: Tx, businessId: string, uploadId: string): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    select u.path from app.file_uploads u
     where u.business_id = ${businessId} and u.id = ${uploadId} and u.deleted_at is null
  `)) as unknown as { path: string }[]
  return row?.path ?? null
}

// ---------------------------------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------------------------------

async function renderCreditNote(ctx: BusinessCtx, head: CreditNoteRecord): Promise<Uint8Array> {
  const { lines, letterhead } = await ctx.tx(async (tx) => ({
    lines: await creditNoteLinesOf(tx, ctx.businessId, head.id),
    letterhead: (head.status === 'issued' && head.letterhead
      ? head.letterhead
      : await letterheadNow(tx, ctx.businessId)) as unknown as LetterheadRow,
  }))
  const issued = head.status === 'issued'
  const tax = head.kind === 'tax_credit_note'
  const values = valuesOf(head)
  const sees = seesCustomers(ctx)
  const customer = issued
    ? {
        name: head.customer_name ?? head.live_name,
        phone: null,
        trn: head.customer_trn,
        addressLine: head.customer_address_line,
        city: head.customer_city,
        emirate: head.customer_emirate,
      }
    : {
        name: head.live_name,
        phone: null,
        trn: sees ? head.live_trn : null,
        addressLine: sees ? head.live_address : null,
        city: sees ? head.live_city : null,
        emirate: sees ? head.live_emirate : null,
      }
  const make = (images: Readonly<Record<string, DocumentPdfImage>>) =>
    buildCreditNotePdfInput({
      business: pdfBusinessOf(letterhead, issued ? head : null, tax),
      creditNote: {
        kind: head.kind,
        number: head.number,
        draft: !issued,
        issueDate: head.issue_date ?? head.today,
        invoiceNumber: head.invoice_number,
        invoiceDate: head.invoice_issue_date,
        reason: head.reason,
        reasonText: head.reason_text,
        by: head.credit_by,
        currency: head.currency,
        vatRegistered: head.vat_registered,
        netTotal: head.net_total,
        vatTotal: head.vat_total,
        total: head.total,
        roundingDifference: head.rounding_difference,
        payable: sumDecimals([head.total, head.rounding_difference]),
        vatRates: head.vat_rates,
        valueBefore: values.valueBefore,
        valueAfter: values.valueAfter,
        notes: head.notes,
        issuedAt: asDate(head.issued_at, asDate(head.created_at, new Date())),
        lines: lines.map((l) => ({
          title: l.description,
          qty: l.qty,
          unit: l.unit,
          unitPrice: l.unit_price,
          priceIncludesVat: l.price_includes_vat,
          vatCategory: l.vat_category,
          vatRate: l.vat_rate,
          net: l.net,
          total: l.total,
        })),
      },
      customer: { ...customer, showTrn: tax },
      businessImages: businessImagesOf(letterhead),
      images,
    })
  return renderDocumentPdf(ctx, wantedImages(letterhead, []), make, { strict: issued })
}

async function renderAndStoreCreditNote(ctx: BusinessCtx, id: string): Promise<Uint8Array> {
  const head = await ctx.tx((tx) => creditNoteHeadOf(tx, ctx, id))
  const pdf = await renderCreditNote(ctx, head)
  if (head.status !== 'issued') return pdf
  const stored = await storeDocumentPdf(ctx, pdf)
  const linked = await ctx.tx(async (tx) => {
    const rows = await tx
      .update(creditNotes)
      .set({ pdfUploadId: stored.id })
      .where(
        and(
          eq(creditNotes.businessId, ctx.businessId),
          eq(creditNotes.id, id),
          isNull(creditNotes.pdfUploadId),
        ),
      )
      .returning({ id: creditNotes.id })
    return rows.length > 0
  })
  if (!linked) await removeStoredDocumentPdf(ctx, stored.path)
  return pdf
}

/** `creditNote.issue` with its PDF (as issueInvoiceWithPdf). */
export async function issueCreditNoteWithPdf(
  ctx: BusinessCtx,
  input: VersionInput,
): Promise<CreditNoteDto> {
  const issued = await issueCreditNote(ctx, input)
  if (issued.status === 'issued' && !issued.pdfStored) {
    try {
      await renderAndStoreCreditNote(ctx, issued.id)
      return { ...issued, pdfStored: true }
    } catch (error) {
      ctx.reportError(error)
    }
  }
  return issued
}

/** `creditNote.pdf` (invoices.documents.view): as invoice.pdf. */
export async function creditNotePdf(ctx: BusinessCtx, input: IdInput): Promise<DocumentPdfDto> {
  const head = await ctx.tx(async (tx) => {
    const head = await creditNoteHeadOf(tx, ctx, input.id)
    await tx.insert(documentRenders).values({
      id: newId(),
      businessId: ctx.businessId,
      kind: 'credit_note',
      documentId: head.id,
    })
    return head
  })
  const fileName = fileNameOf(head.number, head.status === 'draft', 'credit-note')
  if (head.status === 'issued' && head.pdf_upload_id !== null) {
    const path = await ctx.tx(async (tx) => storedPath(tx, ctx.businessId, head.pdf_upload_id!))
    const stored = path ? await readStoredDocumentPdf(ctx, path) : null
    if (stored) return pdfDto(stored, fileName)
    return pdfDto(await renderCreditNote(ctx, head), fileName)
  }
  if (head.status === 'issued')
    return pdfDto(await renderAndStoreCreditNote(ctx, head.id), fileName)
  return pdfDto(await renderCreditNote(ctx, head), fileName)
}
