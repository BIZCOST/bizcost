import {
  ALIAS_TARGETS,
  checkDecimal,
  DATE_ORDERS,
  HEADER_SEARCH_ROWS,
  IMPORT_FIELDS,
  IMPORT_OVERLAPS,
  IMPORT_ROW_ERRORS,
  IMPORT_SHAPES,
  IMPORT_ERRORS_KEPT,
  SALE_IMPORT_STATUSES,
} from '@bizcost/domain'
import { z } from 'zod'
import { withMeta } from '../envelope'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import {
  IMPORT_ANSWERS_MAX,
  IMPORT_CODE_MAX_LENGTH,
  IMPORT_FILE_NAME_MAX_LENGTH,
  IMPORT_HEADER_MAX_LENGTH,
  IMPORT_NAME_MAX_LENGTH,
  IMPORT_PAGE_SIZE,
  IMPORT_ROWS_CHUNK,
  IMPORT_ROWS_MAX,
  STATEMENT_NOTES_MAX_LENGTH,
} from '../sales'
import { sensitive } from '../sensitivity'
import { CONTROL_CHARACTER } from '../text'
import { moneyInput } from './purchases'
import { salesChannelKindDto } from './sales'

// Importing sales from a file and a channel's statements (ROADMAP.md M3 Step 4; docs/DATA_MODEL.md §6;
// the owner's answers Q8 and Q15 of D-218). The file is read in the browser and never sent: only its
// SHA-256, the fingerprint of its headers, the columns chosen, the counts, the rows it left out (row
// and column) and its rows summed into day × item totals (`saleImport.addRows`, in chunks of IMPORT_ROWS_CHUNK).
// Customer names and phones are never among them. Decimals are strings, business days YYYY-MM-DD.
//
// Sensitive (`cost`, redacted without the costs switch): a file's fee column total and everything a
// channel statement holds (what the app kept; D-187). Who sees what: services/sale-imports.ts and
// services/channel-statements.ts.

const isoTimestamp = z.iso.datetime({ offset: true })
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, { message: 'a SHA-256 in hex' })

/** One line of text from a file: trimmed, no control characters, 1–`max`. */
function textInput(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })
}

/** A decimal that fits its column. */
const fits = (kind: 'money' | 'quantity') =>
  zDecimal.refine((value) => checkDecimal(value, kind) === null, { message: `fits ${kind}` })

export const importFieldDto = z.enum(IMPORT_FIELDS)
export const importShapeDto = z.enum(IMPORT_SHAPES)
export const importStatusDto = z.enum(SALE_IMPORT_STATUSES)
export const importOverlapDto = z.enum(IMPORT_OVERLAPS)
export const aliasTargetDto = z.enum(ALIAS_TARGETS)

/**
 * The columns chosen for a file: its header row, the column each field is read from, the header of
 * that column (what the screens show), and the order of day and month in its days.
 */
export const importMappingDto = z.object({
  headerRow: z.int().min(0).max(HEADER_SEARCH_ROWS),
  columns: z.partialRecord(importFieldDto, z.int().min(0).max(9999)),
  headers: z.partialRecord(importFieldDto, z.string().max(IMPORT_HEADER_MAX_LENGTH)),
  dateOrder: z.enum(DATE_ORDERS),
})
export type ImportMappingDto = z.infer<typeof importMappingDto>

/** A row the browser left out: the file's row (1 its first), the column (0 its first) and why. */
export const importRowErrorDto = z.object({
  row: z.int().min(1),
  column: z.int().min(0).nullable(),
  code: z.enum(IMPORT_ROW_ERRORS),
})
export type ImportRowErrorDto = z.infer<typeof importRowErrorDto>

// ---------------------------------------------------------------------------------------------------
// Imports (module sales; sales.imports.manage, which needs sales.documents.manage and .post)
// ---------------------------------------------------------------------------------------------------

/**
 * `saleImport.create`: a draft for a file read in the browser, idempotent on the client's `id`. The
 * same file (its SHA-256) as an import not reversed is ALREADY_IMPORTED (its names: the day, the id
 * when the caller may open it, else '', and its status). A fee column needs sales.channels.manage. One
 * channel and one location (null: the default one; another needs multi_location and one of the
 * member's branches); its days within one month, never after today. `rowCount` staged rows follow by
 * `saleImport.addRows`. The columns are remembered for the file's layout (`fingerprint`).
 */
export const createImportInput = z
  .object({
    id: zUuid,
    channelId: zUuid,
    locationId: zUuid.nullable().default(null),
    fileName: textInput(IMPORT_FILE_NAME_MAX_LENGTH),
    fileHash: hex64,
    fingerprint: hex64,
    shape: importShapeDto,
    periodFrom: zBusinessDate,
    periodTo: zBusinessDate,
    mapping: importMappingDto,
    /** Whether the amounts of its rows include VAT ("Do these amounts include VAT?"). */
    amountsIncludeVat: z.boolean(),
    rowsRead: z.int().min(0),
    rowsLeftOut: z.int().min(0),
    errors: z.array(importRowErrorDto).max(IMPORT_ERRORS_KEPT).default([]),
    /** Σ of the file's fee column (null without one): the channel's statement for its days. */
    feesTotal: moneyInput.nullable().default(null),
    rowCount: z.int().min(1).max(IMPORT_ROWS_MAX),
  })
  .refine((v) => v.periodFrom <= v.periodTo, { message: 'from before to', path: ['periodTo'] })
  .refine((v) => v.periodFrom.slice(0, 7) === v.periodTo.slice(0, 7), {
    message: 'within one month',
    path: ['periodTo'],
  })
export type CreateImportInput = z.input<typeof createImportInput>

/** A staged row: one day × item total of the file (only the mapped columns). */
export const importRowInput = z.object({
  position: z
    .int()
    .min(0)
    .max(IMPORT_ROWS_MAX - 1),
  businessDate: zBusinessDate,
  name: textInput(IMPORT_NAME_MAX_LENGTH),
  code: textInput(IMPORT_CODE_MAX_LENGTH).nullable().default(null),
  qty: fits('quantity'),
  amount: fits('money'),
  refunds: moneyInput.default('0'),
  fileRows: z.int().min(1),
})
export type ImportRowInput = z.input<typeof importRowInput>

/** `saleImport.addRows`: up to IMPORT_ROWS_CHUNK rows of a draft; a position sent again adds nothing. */
export const addImportRowsInput = z.object({
  id: zUuid,
  rows: z
    .array(importRowInput)
    .min(1)
    .max(IMPORT_ROWS_CHUNK)
    .refine((rows) => new Set(rows.map((r) => r.position)).size === rows.length, {
      message: 'a position twice',
    }),
})
export type AddImportRowsInput = z.input<typeof addImportRowsInput>

export const addImportRowsDto = z.object({
  /** Staged rows the import holds now, and how many it expects. */
  received: z.int().min(0),
  expected: z.int().min(1),
})
export type AddImportRowsDto = z.infer<typeof addImportRowsDto>

export const importIdInput = z.object({ id: zUuid })
export type ImportIdInput = z.input<typeof importIdInput>

export const importVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type ImportVersionInput = z.input<typeof importVersionInput>

/**
 * One answer for a name not found (or found, changed): the product it is (`product`), a new product
 * made from it (`new`: `productId` is the new product's client id; needs products.items.manage), or not
 * something the business sells (`skip` tips and the like, `charge` a service charge, `delivery`
 * delivery charged). Saved as an alias of its item code when it has one, else of its name.
 */
export const importAnswerInput = z
  .object({
    name: textInput(IMPORT_NAME_MAX_LENGTH),
    code: textInput(IMPORT_CODE_MAX_LENGTH).nullable().default(null),
    target: z.enum([...ALIAS_TARGETS, 'new']),
    productId: zUuid.nullable().default(null),
  })
  .refine((a) => (a.target === 'product' || a.target === 'new') === (a.productId !== null), {
    message: 'a product with product or new only',
    path: ['productId'],
  })
export type ImportAnswerInput = z.input<typeof importAnswerInput>

/** `saleImport.match`: answers for names of a draft import, saved for the next files too. */
export const matchImportInput = z.object({
  id: zUuid,
  answers: z.array(importAnswerInput).min(1).max(IMPORT_ANSWERS_MAX),
})
export type MatchImportInput = z.input<typeof matchImportInput>

/** `saleImport.setOverlap`: days already imported are skipped (default) or replaced. */
export const setImportOverlapInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  overlap: importOverlapDto,
})
export type SetImportOverlapInput = z.input<typeof setImportOverlapInput>

/** `saleImport.reverse`: the whole import (`day` null) or one of its days. */
export const reverseImportInput = z.object({
  id: zUuid,
  day: zBusinessDate.nullable().default(null),
})
export type ReverseImportInput = z.input<typeof reverseImportInput>

/** `saleImport.list`: newest first. */
export const importListInput = z
  .object({
    status: z.enum(['all', ...SALE_IMPORT_STATUSES]).default('all'),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(100).default(IMPORT_PAGE_SIZE),
  })
  .prefault({})
export type ImportListInput = z.input<typeof importListInput>

/** How an imported name is matched (matchName). */
export const importMatchDto = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('matched'),
    via: z.enum(['alias', 'code', 'name']),
    target: aliasTargetDto,
    productId: zUuid.nullable(),
    /** The product's name (with `product`). */
    productName: z.string().nullable(),
  }),
  z.object({
    state: z.literal('unmatched'),
    /**
     * Up to 3 names that look alike ("Did you mean …?"); null when not looked for yet: only the first
     * names to settle of a preview are compared with the products ("Add all as new" takes only names
     * looked for that look like none).
     */
    suggestions: z.array(z.object({ id: zUuid, name: z.string() })).nullable(),
  }),
])
export type ImportMatchDto = z.infer<typeof importMatchDto>

/** A name the file sold (its rows of every day together). */
export const importNameDto = z.object({
  /** As read first (a variant joined: "Latte · Large"). */
  name: z.string(),
  code: z.string().nullable(),
  /** The file's rows of it, and what they add up to (in the import's kind of amount). */
  fileRows: z.int().min(0),
  qty: zDecimal,
  amount: zDecimal,
  match: importMatchDto,
})
export type ImportNameDto = z.infer<typeof importNameDto>

/** One day of an import (a summary: its one sale's days). */
export const importDayDto = z.object({
  /** The sale's day (a summary's last). */
  businessDate: zBusinessDate,
  /** A summary over several days: its first. */
  periodFrom: zBusinessDate.nullable(),
  /**
   * What the day comes to: once every name is settled (and once finalized), its sales as they post
   * (before VAT for a VAT-registered business, without what is not sold); until then what its rows
   * add up to, as the file gives them (refunds taken off).
   */
  amount: zDecimal,
  /**
   * Every name of the day is settled, so `amount` is what it posts (always once finalized). Until
   * then the screens show no amount for the day: the file's own kind of amount is not what posts.
   */
  settled: z.boolean(),
  /** How many names were sold that day. */
  names: z.int().min(0),
  /**
   * `new`; `imported` (another import's sale covers it: skipped by default, replaced on request);
   * `posted` (this import's own sale); `reversed` (this import's, reversed since); `skipped` (left
   * out when it was finalized: another import had it).
   */
  state: z.enum(['new', 'imported', 'posted', 'reversed', 'skipped']),
  /**
   * The earlier import that covers it (with `imported`), when the caller may open it: another
   * member's or another branch's is never named (D-231).
   */
  importedBy: z.object({ id: zUuid, fileName: z.string() }).nullable(),
  /** Today's sales or One sale entered for the same channel, branch and day (a warning). */
  otherSales: z.boolean(),
  /** This import's sales of the day (posted), the sale first and its refund after. */
  saleIds: z.array(zUuid),
  /** Of saleIds, the day's refund (more refunded than sold of something: negative amounts). */
  refundIds: z.array(zUuid),
})
export type ImportDayDto = z.infer<typeof importDayDto>

export const saleImportDto = z.object({
  id: zUuid,
  status: importStatusDto,
  channelId: zUuid,
  channelName: z.string(),
  channelKind: salesChannelKindDto,
  locationId: zUuid,
  locationName: z.string(),
  fileName: z.string(),
  shape: importShapeDto,
  periodFrom: zBusinessDate,
  periodTo: zBusinessDate,
  mapping: importMappingDto,
  amountsIncludeVat: z.boolean(),
  /** The business's VAT registration now (the sales are posted under it). */
  vatRegistered: z.boolean(),
  currency: z.string(),
  rowsRead: z.int().min(0),
  rowsLeftOut: z.int().min(0),
  errors: z.array(importRowErrorDto),
  /** Σ of the file's fee column: what the app kept (`cost`); null without a fee column. */
  feesTotal: sensitive(zDecimal.nullable(), 'cost'),
  /** Staged rows expected, and received so far (a draft is finalized only with all of them). */
  rowCount: z.int().min(1),
  rowsReceived: z.int().min(0),
  overlap: importOverlapDto,
  /** Σ of the amounts (as the file gives them), and of its refunds. */
  amount: zDecimal,
  refunds: zDecimal,
  /** Sales before VAT, worked out as the import's sales will be (null while names are unmatched). */
  salesBeforeVat: zDecimal.nullable(),
  days: z.array(importDayDto),
  /** Names not settled first, then by name. Empty once finalized (its rows are cleared). */
  names: z.array(importNameDto),
  /** How many names are matched, and how many in all (% matched). */
  matchedNames: z.int().min(0),
  totalNames: z.int().min(0),
  /**
   * The materials of what it sells that have no price yet ("Costs use the purchases entered so far"):
   * a cost fact, null for a member without the costs switch.
   */
  unpricedMaterials: sensitive(
    z.array(z.object({ id: zUuid, name: z.string() })).nullable(),
    'cost',
  ),
  /** The statement made from its fee column once finalized (null otherwise). */
  statementId: zUuid.nullable(),
  /** The days of earlier imports it replaced. */
  replacedDays: z.array(zBusinessDate),
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  createdAt: isoTimestamp,
  postedAt: isoTimestamp.nullable(),
  reversedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type SaleImportDto = z.infer<typeof saleImportDto>

export const saleImportResultDto = withMeta(saleImportDto)
export type SaleImportResultDto = z.infer<typeof saleImportResultDto>

export const importListItemDto = z.object({
  id: zUuid,
  status: importStatusDto,
  fileName: z.string(),
  channelId: zUuid,
  channelName: z.string(),
  locationId: zUuid,
  locationName: z.string(),
  shape: importShapeDto,
  periodFrom: zBusinessDate,
  periodTo: zBusinessDate,
  rowsRead: z.int().min(0),
  /** What its finalized sales came to before VAT (null for a draft, or without "see every sale"). */
  netTotal: zDecimal.nullable(),
  /** Its days with a finalized sale, and those reversed. */
  daysPosted: z.int().min(0),
  daysReversed: z.int().min(0),
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  createdAt: isoTimestamp,
  postedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type ImportListItemDto = z.infer<typeof importListItemDto>

export const importListDto = z.object({
  items: z.array(importListItemDto),
  nextCursor: z.string().nullable(),
})
export type ImportListDto = z.infer<typeof importListDto>

/** A file layout's columns (`importProfile.list`). */
export const importProfileDto = z.object({
  id: zUuid,
  fingerprint: hex64,
  mapping: importMappingDto,
  lastUsedAt: isoTimestamp,
})
export type ImportProfileDto = z.infer<typeof importProfileDto>

export const importProfileListDto = z.object({ items: z.array(importProfileDto) })
export type ImportProfileListDto = z.infer<typeof importProfileListDto>

export const importProfileIdInput = z.object({ id: zUuid })
export type ImportProfileIdInput = z.input<typeof importProfileIdInput>

// ---------------------------------------------------------------------------------------------------
// Channel statements (module sales; sales.channels.manage and the costs switch)
// ---------------------------------------------------------------------------------------------------

const statementFields = {
  periodFrom: zBusinessDate,
  periodTo: zBusinessDate,
  /** The sales the statement lists (for information). */
  sales: moneyInput.nullable().default(null),
  commission: moneyInput.default('0'),
  paymentFees: moneyInput.default('0'),
  otherFees: moneyInput.default('0'),
  ads: moneyInput.default('0'),
  /** Refunds the app charged back. */
  refundsCharged: moneyInput.default('0'),
  /** What the app paid out (for information only). */
  payout: moneyInput.nullable().default(null),
  notes: z
    .string()
    .trim()
    .max(STATEMENT_NOTES_MAX_LENGTH)
    .nullish()
    .transform((value) => (value ? value : null)),
}

const periodOk = (v: { periodFrom: string; periodTo: string }) => v.periodFrom <= v.periodTo
const periodMessage = { message: 'from before to', path: ['periodTo'] }

/** `channelStatement.create`: a draft, idempotent on the client's `id`. */
export const createStatementInput = z
  .object({ id: zUuid, channelId: zUuid, ...statementFields })
  .refine(periodOk, periodMessage)
export type CreateStatementInput = z.input<typeof createStatementInput>

/** `channelStatement.update`: the whole draft, `version` as read. */
export const updateStatementInput = z
  .object({ id: zUuid, version: z.int().positive(), ...statementFields })
  .refine(periodOk, periodMessage)
export type UpdateStatementInput = z.input<typeof updateStatementInput>

export const statementIdInput = z.object({ id: zUuid })
export type StatementIdInput = z.input<typeof statementIdInput>

export const statementVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type StatementVersionInput = z.input<typeof statementVersionInput>

/** `channelStatement.list`: a channel's statements, the latest days first. */
export const statementListInput = z.object({
  channelId: zUuid,
  status: z.enum(['all', ...SALE_IMPORT_STATUSES]).default('all'),
})
export type StatementListInput = z.input<typeof statementListInput>

const costAmount = () => sensitive(zDecimal, 'cost')

export const channelStatementDto = z.object({
  id: zUuid,
  channelId: zUuid,
  channelName: z.string(),
  status: importStatusDto,
  periodFrom: zBusinessDate,
  periodTo: zBusinessDate,
  sales: sensitive(zDecimal.nullable(), 'cost'),
  commission: costAmount(),
  paymentFees: costAmount(),
  otherFees: costAmount(),
  ads: costAmount(),
  refundsCharged: costAmount(),
  /** commission + payment fees + other fees + ads + refunds charged: what counts as its fees. */
  fees: costAmount(),
  payout: sensitive(zDecimal.nullable(), 'cost'),
  notes: z.string().nullable(),
  /** Made from an import's fee column. */
  importId: zUuid.nullable(),
  postedAt: isoTimestamp.nullable(),
  reversedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type ChannelStatementDto = z.infer<typeof channelStatementDto>

export const channelStatementResultDto = withMeta(channelStatementDto)
export type ChannelStatementResultDto = z.infer<typeof channelStatementResultDto>

export const channelStatementListDto = withMeta(z.object({ items: z.array(channelStatementDto) }))
export type ChannelStatementListDto = z.infer<typeof channelStatementListDto>
