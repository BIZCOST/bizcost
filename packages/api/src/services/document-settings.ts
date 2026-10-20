import type {
  DocumentSeriesSettingDto,
  DocumentSettingsDto,
  updateDocumentSettingsInput,
} from '@bizcost/contracts'
import { businesses, type Tx } from '@bizcost/db'
import {
  DOCUMENT_ACCENT_DEFAULT,
  DOCUMENT_COUNTER_DEFAULTS,
  DOCUMENT_SERIES,
  documentNumber,
  isDocumentAccent,
  newId,
  type DocumentAccent,
  type DocumentSeries,
  type Emirate,
} from '@bizcost/domain'
import { eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { addressOf, firstStrongDir } from '../documents/pdf/build'
import { AppError } from '../errors'
import { documentImageUrls } from './document-files'

// Settings → Documents (ROADMAP.md M3 Step 7; the owner's answer Q25 and his document requests of
// 2026-10-16), `settings.documents.manage` while the business prints documents (Quotations, Invoices,
// or since Release B Customers with Payments for the statements; the router checks them): each
// series' prefix and zero padding (editing them renumbers nothing: a document keeps the
// number it was given, D-264) and its first number, settable only until the series' first document
// (SERIES_STARTED after); the footer printed under the totals; a new quotation's default terms and
// validity; the letterhead's accent colour, the logo's watermark, whole amounts without ".00"; and the
// signatory (the signature and stamp images: document-files.ts). Optimistic: the business's version.

type UpdateInput = z.output<typeof updateDocumentSettingsInput>

interface SettingsRow extends Record<string, unknown> {
  document_footer: string | null
  quotation_terms: string | null
  quotation_valid_days: number
  document_accent: string
  document_watermark: boolean
  document_whole_amounts: boolean
  document_signatory: string | null
  document_signature_path: string | null
  document_stamp_path: string | null
  default_locale: string
  address_line: string | null
  city: string | null
  emirate: Emirate | null
  version: number
}

async function settingsRow(tx: Tx, businessId: string, lock = false): Promise<SettingsRow> {
  const [row] = (await tx.execute(sql`
    select b.document_footer, b.quotation_terms, b.quotation_valid_days, b.document_accent,
           b.document_watermark, b.document_whole_amounts, b.document_signatory,
           b.document_signature_path, b.document_stamp_path, b.default_locale, b.address_line,
           b.city, b.emirate, b.version
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
     ${lock ? sql`for update` : sql``}
  `)) as unknown as SettingsRow[]
  if (!row) throw new AppError('forbidden')
  return row
}

interface CounterRow extends Record<string, unknown> {
  series: DocumentSeries
  next_no: number
  first_no: number
  prefix: string
  padding: number
}

async function countersOf(
  tx: Tx,
  businessId: string,
  lock = false,
): Promise<Map<string, CounterRow>> {
  const rows = (await tx.execute(sql`
    select c.series, c.next_no, c.first_no, c.prefix, c.padding
      from app.document_counters c
     where c.business_id = ${businessId} and c.deleted_at is null
     order by c.series
     ${lock ? sql`for update` : sql``}
  `)) as unknown as CounterRow[]
  return new Map(rows.map((row) => [row.series, row] as const))
}

/** Each series as Settings shows it (a series no document took yet: its defaults). */
function seriesOf(counters: Map<string, CounterRow>): DocumentSeriesSettingDto[] {
  return DOCUMENT_SERIES.map((series) => {
    const defaults = DOCUMENT_COUNTER_DEFAULTS[series]
    const row = counters.get(series)
    const prefix = row?.prefix ?? defaults.prefix
    const padding = row?.padding ?? defaults.padding
    const nextNo = row?.next_no ?? defaults.first
    const firstNo = row?.first_no ?? defaults.first
    return {
      series,
      prefix,
      padding,
      firstNo,
      nextNo,
      started: nextNo > firstNo,
      example: documentNumber(prefix, nextNo, padding),
    }
  })
}

/** `document.settings`. */
export async function documentSettings(ctx: BusinessCtx): Promise<DocumentSettingsDto> {
  const { row, counters } = await ctx.tx(async (tx) => ({
    row: await settingsRow(tx, ctx.businessId),
    counters: await countersOf(tx, ctx.businessId),
  }))
  const urls = await documentImageUrls(ctx, {
    signature: row.document_signature_path,
    stamp: row.document_stamp_path,
  })
  return {
    series: seriesOf(counters),
    footer: row.document_footer,
    quotationTerms: row.quotation_terms,
    quotationValidDays: row.quotation_valid_days,
    accent: isDocumentAccent(row.document_accent) ? row.document_accent : DOCUMENT_ACCENT_DEFAULT,
    watermark: row.document_watermark,
    wholeAmounts: row.document_whole_amounts,
    signatory: row.document_signatory,
    ...urls,
    letterheadAddress: letterheadAddressOf(row),
    version: row.version,
  }
}

/** The letterhead's address line as the PDF prints it (build.ts addressOf), with its direction. */
function letterheadAddressOf(row: SettingsRow): DocumentSettingsDto['letterheadAddress'] {
  const locale = row.default_locale === 'ar' ? 'ar' : 'en'
  const text = addressOf(row.address_line, row.city, row.emirate, locale)
  return text === null ? null : { text, dir: firstStrongDir(text, locale === 'ar' ? 'rtl' : 'ltr') }
}

/**
 * `document.updateSettings`: the whole form, `version` as read (CONFLICT otherwise). A series named
 * changes its prefix and padding; its first number (and so its next) only while no document took a
 * number of it (SERIES_STARTED otherwise). A series no document took yet gets its counter here. Lock
 * order: the business row, then its counters (a document's create locks its counter last and never
 * the business row FOR UPDATE, so the two wait for each other at most).
 */
export async function updateDocumentSettings(
  ctx: BusinessCtx,
  input: UpdateInput,
): Promise<DocumentSettingsDto> {
  await ctx.tx(async (tx) => {
    const current = await settingsRow(tx, ctx.businessId, true)
    if (current.version !== input.version) {
      throw new AppError('conflict', { message: 'the settings were changed meanwhile' })
    }
    const counters = await countersOf(tx, ctx.businessId, true)
    for (const wanted of input.series) {
      const row = counters.get(wanted.series)
      const defaults = DOCUMENT_COUNTER_DEFAULTS[wanted.series]
      const started = row !== undefined && row.next_no > row.first_no
      const firstNo = wanted.firstNo ?? row?.first_no ?? defaults.first
      if (started && wanted.firstNo !== undefined && wanted.firstNo !== row.first_no) {
        throw new AppError('series_started')
      }
      if (row === undefined) {
        await tx.execute(sql`
          insert into app.document_counters (id, business_id, series, next_no, first_no, prefix, padding)
          values (${newId()}, ${ctx.businessId}, ${wanted.series}, ${firstNo}, ${firstNo},
                  ${wanted.prefix}, ${wanted.padding})
        `)
      } else {
        await tx.execute(sql`
          update app.document_counters c
             set prefix = ${wanted.prefix}, padding = ${wanted.padding},
                 first_no = ${started ? row.first_no : firstNo},
                 next_no = ${started ? row.next_no : firstNo}
           where c.business_id = ${ctx.businessId} and c.series = ${wanted.series}
        `)
      }
    }
    if (!isDocumentAccent(input.accent)) throw new AppError('validation', { message: 'accent' })
    const accent: DocumentAccent = input.accent
    await tx
      .update(businesses)
      .set({
        documentFooter: input.footer,
        quotationTerms: input.quotationTerms,
        quotationValidDays: input.quotationValidDays,
        documentAccent: accent,
        documentWatermark: input.watermark,
        documentWholeAmounts: input.wholeAmounts,
        documentSignatory: input.signatory,
      })
      .where(eq(businesses.id, ctx.businessId))
  })
  return documentSettings(ctx)
}
