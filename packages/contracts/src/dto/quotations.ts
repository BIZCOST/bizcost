import {
  QUOTATION_LIST_STATUSES,
  QUOTATION_STATUSES,
  VAT_CATEGORIES,
  checkDecimal,
  compareDecimal,
} from '@bizcost/domain'
import { z } from 'zod'
import {
  PAYMENT_STAGE_DUE_MAX_LENGTH,
  PAYMENT_STAGE_LABEL_MAX_LENGTH,
  QUOTATION_ANSWER_NOTE_MAX_LENGTH,
  QUOTATION_AREA_MAX_LENGTH,
  QUOTATION_CUSTOMER_REF_MAX_LENGTH,
  QUOTATION_GREETING_MAX_LENGTH,
  QUOTATION_INTRO_MAX_LENGTH,
  QUOTATION_LINE_DETAILS_MAX_LENGTH,
  QUOTATION_LINE_NOTE_MAX_LENGTH,
  QUOTATION_LINE_TITLE_MAX_LENGTH,
  QUOTATION_LINES_MAX,
  QUOTATION_NOTES_MAX_LENGTH,
  QUOTATION_PAGE_SIZE,
  QUOTATION_PAGE_SIZE_MAX,
  QUOTATION_SITE_MAX_LENGTH,
  QUOTATION_TERMS_MAX_LENGTH,
} from '../documents'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import { standardUnitDto } from './catalog'
import { discountDto, discountInput, moneyInput } from './purchases'
import { saleQtyInput } from './sales'
import { hasVisibleCharacter } from '../text'
import { optionalLine } from './suppliers'

// Quotations (ROADMAP.md M3 Step 7; docs/DATA_MODEL.md §6; the owner's answers Q21–Q25 of D-218 and his
// document requests of 2026-10-16). A quotation is numbered when created (Q-0001…, which may skip: a
// discarded draft keeps its number) and goes draft → sent → accepted or declined; a sent revision is
// frozen ("Revise" makes the next one under the same number, and the one before is superseded once the
// new one is sent). "Expired" is no status: a sent quotation past its `validUntil` lists as expired. Its
// lines are products and services, or typed (Q21), with an optional area or room, a title, details
// that keep their line breaks and a highlighted note; its amounts are the sales engine's, with a
// document discount and "Round the total" («تقريب الإجمالي», D-221); its optional payment stages share
// its payable total (each but the last rounded on its own, the last the exact rest).
//
// Who (Q10): `quotations.documents.view` sees the business's quotations (within one's branches, Q12);
// `.manage` prepares, sends, revises, copies and discards them and makes an order of an accepted one
// (with Orders on and `orders.documents.manage`); `.decide` records the customer's answer. Prices are
// not sensitive (D-187): nothing here is a redaction category.

const isoTimestamp = z.iso.datetime({ offset: true })

export const quotationStatusDto = z.enum(QUOTATION_STATUSES)
export const quotationListStatusDto = z.enum(QUOTATION_LIST_STATUSES)

const uniqueIds = (items: readonly { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length

/** No control character but line breaks (each kind stored as \n); '' means none. */
const MULTILINE_CONTROL = /(?!\n)\p{Cc}/u
function multilineInput(max: number) {
  return z
    .string()
    .overwrite((value) => value.replace(/\r\n?/g, '\n'))
    .trim()
    .max(max)
    .refine((value) => !MULTILINE_CONTROL.test(value), { message: 'control character' })
    .nullish()
    .transform((value) => (value ? value : null))
}

/** A one-line text that must be given (a stage's "when"). */
function requiredLine(max: number) {
  return optionalLine(max).refine((value) => value !== null, { message: 'required' })
}

/** A stage's % of the payable total: more than 0, at most 100, at most 4 decimals. */
const stagePercentInput = zDecimal.refine(
  (v) =>
    checkDecimal(v, 'percent') === null &&
    compareDecimal(v, '0') > 0 &&
    compareDecimal(v, '100') <= 0 &&
    !/\.\d{5,}$/.test(v),
  { message: 'more than 0 and at most 100, with at most 4 decimals' },
)

/**
 * A line: a product or service of the business (`productId`; its name is the title unless typed,
 * D-002, and its unit, VAT category and whether its price includes VAT are copied from it), or typed
 * (`productId` null, Q21: its title is required, and its unit, VAT category (standard by default) and
 * whether its price includes VAT are as typed; a price including VAT needs VAT registration,
 * CAPABILITY_DISABLED). `area` puts the line in an area or room: the API saves each area's lines
 * together (in the order sent, the areas in the order each first comes, a line without an area in its
 * place among them; one area's lines in its first line's spelling, D-299), so the PDF's area cell
 * spans exactly its lines. An area's name needs something to see (not only invisible characters,
 * VALIDATION): the PDF writes it up its cell.
 */
export const quotationLineInput = z
  .object({
    id: zUuid,
    productId: zUuid.nullable().default(null),
    area: optionalLine(QUOTATION_AREA_MAX_LENGTH).refine(
      (value) => value === null || hasVisibleCharacter(value),
      { message: 'nothing to see' },
    ),
    description: optionalLine(QUOTATION_LINE_TITLE_MAX_LENGTH),
    details: multilineInput(QUOTATION_LINE_DETAILS_MAX_LENGTH),
    note: multilineInput(QUOTATION_LINE_NOTE_MAX_LENGTH),
    qty: saleQtyInput,
    /** A typed line's unit (m², m, piece…); null: none. A product's own is used for a product. */
    unit: standardUnitDto.nullish().transform((value) => value ?? null),
    unitPrice: moneyInput,
    /** A typed line's: its price includes VAT. A product's own is used for a product. */
    priceIncludesVat: z.boolean().default(false),
    /** A typed line's VAT category. A product's own is used for a product. */
    vatCategory: z.enum(VAT_CATEGORIES).default('standard'),
    discount: discountInput.nullish().transform((value) => value ?? null),
  })
  .refine((line) => line.productId !== null || line.description !== null, {
    message: 'a typed line needs its title',
    path: ['description'],
  })
export type QuotationLineInput = z.input<typeof quotationLineInput>

/** A payment stage (the amount is worked out from the payable total). */
export const quotationStageInput = z.object({
  /** "1st payment"; null: "Payment 1"… on the PDF. */
  label: optionalLine(PAYMENT_STAGE_LABEL_MAX_LENGTH),
  /** When it is due: "Upon signing", "On delivery". */
  due: requiredLine(PAYMENT_STAGE_DUE_MAX_LENGTH),
  percent: stagePercentInput,
})
export type QuotationStageInput = z.input<typeof quotationStageInput>

const quotationFields = {
  /** The customer (a live one of the business): required ("Dear …"). */
  customerId: zUuid,
  /** Where the work is done or sold from; null: the default location (another needs branches). */
  locationId: zUuid.nullable().default(null),
  /** The quotation's date (never after today: FUTURE_DATE). */
  businessDate: zBusinessDate,
  /**
   * The last day it is valid (on or after its date); null: not said. Left out: on create, its date +
   * the business's validity days (Settings → Documents); on update, kept.
   */
  validUntil: zBusinessDate.nullish(),
  customerRef: optionalLine(QUOTATION_CUSTOMER_REF_MAX_LENGTH),
  /** The project or site ("Villa 12, Al Barsha"), printed after the customer's name. */
  site: optionalLine(QUOTATION_SITE_MAX_LENGTH),
  /** A discount on the whole quotation: a % of its lines, or an amount typed like their prices. */
  discount: discountInput.nullish().transform((value) => value ?? null),
  /**
   * "Round the total" («تقريب الإجمالي», D-221): the total wanted, with VAT. The server works out the
   * adjustment before VAT and any rounding difference (at most 0.02) on every save; null: none.
   */
  roundTo: moneyInput.nullish().transform((value) => value ?? null),
  /**
   * The greeting as typed ("Dear Eng. Hamdan,"); null: the business's language's own, with the
   * customer's name and the project («السادة / <name>،», "Dear <name>,").
   */
  greeting: optionalLine(QUOTATION_GREETING_MAX_LENGTH),
  /** The sentence after the greeting; null: the default of each language. */
  intro: multilineInput(QUOTATION_INTRO_MAX_LENGTH),
  /** Printed terms. Left out: on create the business's default terms, on update kept. */
  terms: multilineInput(QUOTATION_TERMS_MAX_LENGTH).optional(),
  notes: multilineInput(QUOTATION_NOTES_MAX_LENGTH),
  lines: z
    .array(quotationLineInput)
    .max(QUOTATION_LINES_MAX)
    .default([])
    .refine(uniqueIds, { message: 'duplicate line id' }),
  /** Payment terms: none, or stages whose % add up to 100 (VALIDATION otherwise). */
  stages: z.array(quotationStageInput).max(10).default([]),
}

const validFits = (q: { businessDate: string; validUntil?: string | null | undefined }) =>
  q.validUntil === undefined || q.validUntil === null || q.validUntil >= q.businessDate
const validMessage = {
  message: 'valid until on or after the quotation’s date',
  path: ['validUntil'],
}

/**
 * `quotation.create` (quotations.documents.manage): a draft numbered Q-0001…, idempotent on the
 * client's `id` (a replay is answered from the quotation before a number is taken).
 */
export const createQuotationInput = z
  .object({ id: zUuid, ...quotationFields })
  .refine(validFits, validMessage)
export type CreateQuotationInput = z.input<typeof createQuotationInput>

/** `quotation.update` (a draft only): the whole quotation, `version` as read. */
export const updateQuotationInput = z
  .object({ id: zUuid, version: z.int().positive(), ...quotationFields })
  .refine(validFits, validMessage)
export type UpdateQuotationInput = z.input<typeof updateQuotationInput>

/** `quotation.get`, `quotation.history`, `quotation.pdf`. */
export const quotationIdInput = z.object({ id: zUuid })
export type QuotationIdInput = z.input<typeof quotationIdInput>

/** `quotation.discard` (a draft) and `quotation.send` (a draft; a repeated send changes nothing). */
export const quotationVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type QuotationVersionInput = z.input<typeof quotationVersionInput>

/** `quotation.accept` (quotations.documents.decide; a sent revision): with an optional note. */
export const acceptQuotationInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  note: optionalLine(QUOTATION_ANSWER_NOTE_MAX_LENGTH),
})
export type AcceptQuotationInput = z.input<typeof acceptQuotationInput>

/** `quotation.decline` (quotations.documents.decide; a sent revision): with an optional reason. */
export const declineQuotationInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  reason: optionalLine(QUOTATION_ANSWER_NOTE_MAX_LENGTH),
})
export type DeclineQuotationInput = z.input<typeof declineQuotationInput>

/**
 * `quotation.revise` (the latest revision, once sent): a new draft revision `newId` under the same
 * number, a copy of it (its lines' pictures too). Idempotent on `newId`.
 */
export const reviseQuotationInput = z.object({ id: zUuid, newId: zUuid })
export type ReviseQuotationInput = z.input<typeof reviseQuotationInput>

/**
 * `quotation.copy`: a new quotation `newId` (a new number) from any revision, for its customer or
 * `customerId`, dated today. Idempotent on `newId`.
 */
export const copyQuotationInput = z.object({
  id: zUuid,
  newId: zUuid,
  customerId: zUuid.optional(),
})
export type CopyQuotationInput = z.input<typeof copyQuotationInput>

/**
 * `quotation.toOrder` (an accepted revision; Orders on and orders.documents.manage): a pending order
 * `orderId` with its customer, lines (typed ones stay typed, Q21), discount and reference, through
 * `channelId` (null: the business's only active channel). Once: a repeat returns the order made.
 */
export const quotationToOrderInput = z.object({
  id: zUuid,
  orderId: zUuid,
  channelId: zUuid.nullable().default(null),
  dueDate: zBusinessDate.nullable().default(null),
})
export type QuotationToOrderInput = z.input<typeof quotationToOrderInput>

/**
 * `quotation.list`: the latest revision of each quotation, newest first (by its date, then its
 * number); `status` filters (expired: sent and past its validity); the search finds the number, the
 * customer's reference and the customer's name.
 */
export const quotationListInput = z
  .object({
    status: z.enum(['all', 'draft', 'sent', 'expired', 'accepted', 'declined']).default('all'),
    customerId: zUuid.optional(),
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(QUOTATION_PAGE_SIZE_MAX).default(QUOTATION_PAGE_SIZE),
  })
  .prefault({})
export type QuotationListInput = z.input<typeof quotationListInput>

export const quotationLineDto = z.object({
  id: zUuid,
  productId: zUuid.nullable(),
  /** No product: typed on the quotation (Q21). */
  typed: z.boolean(),
  area: z.string().nullable(),
  description: z.string(),
  details: z.string().nullable(),
  note: z.string().nullable(),
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  unitPrice: zDecimal,
  priceIncludesVat: z.boolean(),
  discount: discountDto.nullable(),
  vatCategory: z.enum(VAT_CATEGORIES).nullable(),
  vatRate: zDecimal.nullable(),
  subtotal: zDecimal,
  /** Its own discount as an amount. */
  lineDiscount: zDecimal,
  /** Before VAT, after every discount and its share of "Round the total". */
  net: zDecimal,
  vat: zDecimal,
  total: zDecimal,
  /** Its picture (an attachment of entity quotation_line), with a signed URL; null: none. */
  picture: z.object({ id: zUuid, fileName: z.string(), url: z.string().nullable() }).nullable(),
})
export type QuotationLineDto = z.infer<typeof quotationLineDto>

export const quotationStageDto = z.object({
  id: zUuid,
  label: z.string().nullable(),
  due: z.string(),
  percent: zDecimal,
  /** Its share of the payable total. */
  amount: zDecimal,
})
export type QuotationStageDto = z.infer<typeof quotationStageDto>

/** One VAT rate of the quotation (only for a VAT-registered business). */
export const quotationVatRateDto = z.object({
  vatCategory: z.enum(VAT_CATEGORIES).nullable(),
  vatRate: zDecimal.nullable(),
  net: zDecimal,
  vat: zDecimal,
})
export type QuotationVatRateDto = z.infer<typeof quotationVatRateDto>

/** A revision of the same quotation (number). */
export const quotationRevisionDto = z.object({
  id: zUuid,
  revision: z.int().positive(),
  status: quotationStatusDto,
  businessDate: zBusinessDate,
  sentAt: isoTimestamp.nullable(),
  payable: zDecimal,
})
export type QuotationRevisionDto = z.infer<typeof quotationRevisionDto>

export const quotationDto = z.object({
  id: zUuid,
  /** Its first revision (the number's own id). */
  rootId: zUuid,
  /** As printed ("Q-0001"); the same for every revision. */
  number: z.string(),
  seq: z.int().positive(),
  revision: z.int().positive(),
  status: quotationStatusDto,
  /** Its status, or `expired` for a sent one past its validity (today in the business's time zone). */
  listStatus: quotationListStatusDto,
  /** The latest revision of its number (a draft revision counts). */
  latest: z.boolean(),
  customerId: zUuid,
  customerName: z.string(),
  customerPhoneLast4: z.string().nullable(),
  locationId: zUuid,
  locationName: z.string(),
  businessDate: zBusinessDate,
  validUntil: zBusinessDate.nullable(),
  customerRef: z.string().nullable(),
  site: z.string().nullable(),
  /** The VAT registration it was last saved under (frozen once sent). */
  vatRegistered: z.boolean(),
  currency: z.string(),
  discount: discountDto.nullable(),
  /** "Round the total": the total typed, the adjustment before VAT, the rounding difference. */
  roundTo: zDecimal.nullable(),
  adjustment: zDecimal,
  roundingDifference: zDecimal,
  subtotal: zDecimal,
  discountTotal: zDecimal,
  netTotal: zDecimal,
  vatTotal: zDecimal,
  total: zDecimal,
  /** What the customer is asked to pay (total + rounding difference). */
  payable: zDecimal,
  vatRates: z.array(quotationVatRateDto),
  greeting: z.string().nullable(),
  intro: z.string().nullable(),
  terms: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(quotationLineDto),
  stages: z.array(quotationStageDto),
  /** Every revision of its number, the first first. */
  revisions: z.array(quotationRevisionDto),
  sentAt: isoTimestamp.nullable(),
  acceptedAt: isoTimestamp.nullable(),
  acceptNote: z.string().nullable(),
  declinedAt: isoTimestamp.nullable(),
  declineReason: z.string().nullable(),
  supersededAt: isoTimestamp.nullable(),
  /** The order made from it, and its number. */
  orderId: zUuid.nullable(),
  orderNumber: z.string().nullable(),
  /** Another revision of its number became an order (it cannot become one too). */
  otherHasOrder: z.boolean(),
  /**
   * An issued invoice bills a revision of it (a deposit, a stage): it is invoiced from the quotation
   * to the end and never made an order (QUOTATION_INVOICED, M3 Step 8).
   */
  invoiced: z.boolean(),
  /** The revision it was copied from, and its number. */
  copiedFromId: zUuid.nullable(),
  copiedFromNumber: z.string().nullable(),
  /** Who prepared it (their name in the business now); null without a team. */
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type QuotationDto = z.infer<typeof quotationDto>

export const quotationListItemDto = z.object({
  id: zUuid,
  rootId: zUuid,
  number: z.string(),
  revision: z.int().positive(),
  status: quotationStatusDto,
  listStatus: quotationListStatusDto,
  customerId: zUuid,
  customerName: z.string(),
  customerRef: z.string().nullable(),
  site: z.string().nullable(),
  businessDate: zBusinessDate,
  validUntil: zBusinessDate.nullable(),
  currency: z.string(),
  payable: zDecimal,
  /** How many lines, and the titles of the first two. */
  lineCount: z.int().nonnegative(),
  lineTitles: z.array(z.string()),
  orderId: zUuid.nullable(),
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  version: z.int().positive(),
})
export type QuotationListItemDto = z.infer<typeof quotationListItemDto>

export const quotationListDto = z.object({
  items: z.array(quotationListItemDto),
  nextCursor: z.string().nullable(),
})
export type QuotationListDto = z.infer<typeof quotationListDto>

/** `quotation.toOrder`: the quotation and the order made from it. */
export const quotationOrderDto = z.object({
  quotation: quotationDto,
  orderId: zUuid,
  orderNumber: z.string(),
})
export type QuotationOrderDto = z.infer<typeof quotationOrderDto>

export const QUOTATION_EVENT_KINDS = [
  'created',
  'copied',
  'revised',
  'edited',
  'sent',
  'accepted',
  'declined',
  'superseded',
  'ordered',
  'discarded',
] as const
export type QuotationEventKind = (typeof QUOTATION_EVENT_KINDS)[number]

/**
 * `quotation.history`: what happened to the quotation's revisions, newest first, read from their
 * status columns and the revisions themselves, with who and when from the audit log (never its row
 * data). `byName` is the member's name in the business now (null without a team, or for a member who
 * left).
 */
export const quotationHistoryDto = z.object({
  events: z.array(
    z.object({
      kind: z.enum(QUOTATION_EVENT_KINDS),
      revision: z.int().positive(),
      at: isoTimestamp,
      byName: z.string().nullable(),
      /** The note with an acceptance, the reason with a decline. */
      note: z.string().nullable(),
      /** `copied`: the number it was copied from; `ordered`: the order's number. */
      reference: z.string().nullable(),
    }),
  ),
})
export type QuotationHistoryDto = z.infer<typeof quotationHistoryDto>

/**
 * `quotation.pdf`: the revision's PDF (a draft's is marked as a draft), base64, to download or share.
 * Each call counts against the rate limit (RATE_LIMITED).
 */
export const documentPdfDto = z.object({
  fileName: z.string(),
  contentType: z.literal('application/pdf'),
  /** The PDF's bytes in base64. */
  base64: z.string(),
  pages: z.int().positive(),
  bytes: z.int().positive(),
})
export type DocumentPdfDto = z.infer<typeof documentPdfDto>
