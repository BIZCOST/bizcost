import type { DocumentPdfDto, quotationIdInput } from '@bizcost/contracts'
import { documentRenders, type Tx } from '@bizcost/db'
import { newId, type Emirate } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { buildQuotationPdfInput, type PdfBusiness } from '../documents/pdf/build'
import type { DocumentPdfImage } from '../documents/pdf/input'
import { AppError } from '../errors'
import { renderDocumentPdf, type PrintableImage } from './document-files'
import { linesOf, quotationHeadOf, stagesOf, type QuotationHeadRecord } from './quotations'

// A quotation's PDF (ROADMAP.md M3 Step 7; D-224; the owner's document requests of 2026-10-16), made
// on request from the revision as it is (a draft's is marked as a draft): the business's own
// letterhead (its names, logo, accent colour, watermark, contact lines, signatory, signature and stamp,
// Settings → Documents and the business profile), the customer, the opening, the lines with their
// areas and pictures, the totals with VAT per rate, the payment stages, the validity, the terms, the
// notes and the payment details. Each PDF is counted in the database first (document_renders: at most
// 300 a business an hour and 20 a member a minute, RATE_LIMITED); its images are read from the
// business's own Storage objects only; it renders in the PDF worker (engine.ts).

type IdInput = z.output<typeof quotationIdInput>

interface BusinessRow extends Record<string, unknown> {
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

interface CustomerRow extends Record<string, unknown> {
  name: string
  phone: string | null
  trn: string | null
  address_line: string | null
  city: string | null
  emirate: Emirate | null
}

async function businessOf(tx: Tx, businessId: string): Promise<BusinessRow> {
  const [row] = (await tx.execute(sql`
    select b.legal_name, b.legal_name_ar, b.default_locale, b.vat_registered, b.trn, b.phone,
           b.phone_2, b.email, b.address_line, b.city, b.emirate, b.trade_licence_no,
           b.document_accent, b.document_watermark, b.document_whole_amounts,
           b.document_signatory, b.document_footer, b.logo_path, b.document_signature_path,
           b.document_stamp_path
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as BusinessRow[]
  if (!row) throw new AppError('forbidden')
  return row
}

/**
 * The PDF's file name: its number (characters a file name keeps), its revision after the first, and
 * "-draft" for a draft's (D-296: a draft's PDF is never taken for the one sent).
 */
function fileNameOf(head: QuotationHeadRecord): string {
  const safe = head.number.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'quotation'
  const revision = head.revision > 1 ? `-R${head.revision}` : ''
  return `${safe}${revision}${head.status === 'draft' ? '-draft' : ''}.pdf`
}

/** How many pages a Typst PDF has (its page objects). */
export function pdfPageCount(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1')
  return Math.max(1, (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length)
}

/**
 * `quotation.pdf` (quotations.documents.view): the revision's PDF, base64. Each call is counted first
 * (RATE_LIMITED over the limits).
 */
export async function quotationPdf(ctx: BusinessCtx, input: IdInput): Promise<DocumentPdfDto> {
  const source = await ctx.tx(async (tx) => {
    const head = await quotationHeadOf(tx, ctx, input.id)
    await tx.insert(documentRenders).values({
      id: newId(),
      businessId: ctx.businessId,
      kind: 'quotation',
      documentId: head.id,
    })
    const lines = await linesOf(tx, ctx.businessId, head.id)
    const stages = await stagesOf(tx, ctx.businessId, head.id)
    const business = await businessOf(tx, ctx.businessId)
    const [customer] = (await tx.execute(sql`
      select c.name, c.phone, c.trn, c.address_line, c.city, c.emirate from app.customers c
       where c.business_id = ${ctx.businessId} and c.id = ${head.customer_id}
    `)) as unknown as CustomerRow[]
    if (!customer) throw new AppError('not_found')
    return { head, lines, stages, business, customer }
  })
  const { head, lines, stages, business, customer } = source

  // The images it prints: only the business's own objects (document-files.ts checks each path).
  const wanted: PrintableImage[] = []
  if (business.logo_path) wanted.push({ key: 'logo', path: business.logo_path })
  if (business.document_signature_path) {
    wanted.push({ key: 'signature', path: business.document_signature_path })
  }
  if (business.document_stamp_path)
    wanted.push({ key: 'stamp', path: business.document_stamp_path })
  lines.forEach((line, i) => {
    if (line.picture_path) wanted.push({ key: `line-${i + 1}`, path: line.picture_path })
  })
  const pdfBusiness: PdfBusiness = {
    legalName: business.legal_name,
    legalNameAr: business.legal_name_ar,
    locale: business.default_locale === 'ar' ? 'ar' : 'en',
    vatRegistered: head.vat_registered,
    trn: business.trn,
    phone: business.phone,
    phone2: business.phone_2,
    email: business.email,
    addressLine: business.address_line,
    city: business.city,
    emirate: business.emirate,
    tradeLicenceNo: business.trade_licence_no,
    accent: business.document_accent,
    watermark: business.document_watermark,
    wholeAmounts: business.document_whole_amounts,
    signatory: business.document_signatory,
    footer: business.document_footer,
  }
  const issued = head.sent_at ?? head.updated_at
  const make = (images: Readonly<Record<string, DocumentPdfImage>>) =>
    buildQuotationPdfInput({
      business: pdfBusiness,
      quotation: {
        number: head.number,
        revision: head.revision,
        draft: head.status === 'draft',
        businessDate: head.business_date,
        validUntil: head.valid_until,
        customerRef: head.customer_ref,
        site: head.site,
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
        greeting: head.greeting,
        intro: head.intro,
        terms: head.terms,
        notes: head.notes,
        issuedAt: issued instanceof Date ? issued : new Date(issued),
        lines: lines.map((line, i) => ({
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
        stages: stages.map((stage) => ({
          label: stage.label,
          due: stage.due,
          percent: stage.percent,
          amount: stage.amount,
        })),
      },
      customer: {
        name: customer.name,
        phone: customer.phone,
        trn: customer.trn,
        addressLine: customer.address_line,
        city: customer.city,
        emirate: customer.emirate,
      },
      businessImages: {
        logo: business.logo_path ? 'logo' : null,
        signature: business.document_signature_path ? 'signature' : null,
        stamp: business.document_stamp_path ? 'stamp' : null,
      },
      images,
    })
  const pdf = await renderDocumentPdf(ctx, wanted, make)
  return {
    fileName: fileNameOf(head),
    contentType: 'application/pdf',
    base64: Buffer.from(pdf).toString('base64'),
    pages: pdfPageCount(pdf),
    bytes: pdf.byteLength,
  }
}
