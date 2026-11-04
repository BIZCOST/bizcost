import {
  checkDecimal,
  compareDecimal,
  DOCUMENT_STATUSES,
  STOCK_COUNT_KINDS,
  STOCK_MOVEMENT_KINDS,
} from '@bizcost/domain'
import { z } from 'zod'
import { CATALOG_SEARCH_MAX_LENGTH } from '../catalog'
import { withMeta } from '../envelope'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import { sensitive } from '../sensitivity'
import {
  COUNT_PARTS_MAX,
  STOCK_CARD_PAGE_SIZE,
  STOCK_CARD_PAGE_SIZE_MAX,
  STOCK_COUNT_LINES_MAX,
  STOCK_COUNT_NOTE_MAX_LENGTH,
  STOCK_PAGE_SIZE,
  STOCK_PAGE_SIZE_MAX,
} from '../stock'
import { dimensionDto, materialCrossFactorDto, materialPackDto, standardUnitDto } from './catalog'
import { documentStatusDto } from './purchases'

// Stock on hand, the stock card and counts (ROADMAP.md M4 Step 2; D-339, D-340). Module `inventory`
// with keeps_stock. Quantities are base quantities of the material (g, ml, piece…: its dimension's
// base unit) as decimal strings; each answer carries the material's unit and packs, so a screen can
// say them in packs ("12 cartons + 3 bottles (147 L)"). Business days YYYY-MM-DD, timestamps ISO.
//
// Sensitive (redacted for members without data.cost.view; D-026, D-190): what stock is worth, an
// average, a difference's value and what a movement moved the stock's value by are `cost`. Outputs
// with such fields are withMeta() envelopes.
//
// Blind counting (Q6): a count's lines carry what the book expected and the difference only for a
// member who manages counts, and only once the count is finalized (`count.review` shows them for a
// draft, to that member alone). For anyone else those fields are absent, not null.

const isoTimestamp = z.iso.datetime({ offset: true })

/** Several ids, once each. */
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length

/** Materials a count starts with or gets: at least one, at most a count's lines, once each. */
const materialIdsInput = z
  .array(zUuid)
  .min(1)
  .max(STOCK_COUNT_LINES_MAX)
  .refine(uniqueIds, { message: 'duplicate material' })

const pageCursor = z.string().min(1).max(500).optional()

/** A count's note: one short line, optional. */
const noteInput = z
  .string()
  .trim()
  .max(STOCK_COUNT_NOTE_MAX_LENGTH)
  .nullish()
  .transform((value) => (value ? value : null))

export const stockCountKindDto = z.enum(STOCK_COUNT_KINDS)
export const stockMovementKindDto = z.enum(STOCK_MOVEMENT_KINDS)

/** A material as stock answers carry it: its name and the units it is counted and said in. */
export const stockMaterialDto = z.object({
  id: zUuid,
  name: z.string(),
  dimension: dimensionDto,
  /** The standard unit it is counted in (kg, l, piece…); the averages below are per one of it. */
  unit: standardUnitDto,
  /** Its live packs, in the order they were added. */
  packs: z.array(materialPackDto),
  crossFactors: z.array(materialCrossFactorDto),
  archived: z.boolean(),
})
export type StockMaterialDto = z.infer<typeof stockMaterialDto>

// ---------------------------------------------------------------------------------------------------
// Stock on hand (inventory.stock.view)
// ---------------------------------------------------------------------------------------------------

/** `stock.list`: the tracked materials by name, in the caller's branches. */
export const stockListInput = z
  .object({
    /** Only this branch (one of the caller's; FORBIDDEN otherwise). */
    locationId: zUuid.optional(),
    /** Part of the material's name, any case. */
    search: z.string().trim().max(CATALOG_SEARCH_MAX_LENGTH).optional(),
    cursor: pageCursor,
    limit: z.int().min(1).max(STOCK_PAGE_SIZE_MAX).default(STOCK_PAGE_SIZE),
  })
  .prefault({})
export type StockListInput = z.input<typeof stockListInput>

export const stockBranchDto = z.object({
  locationId: zUuid,
  locationName: z.string(),
  /** On hand at the end of today, in base units (below zero: more went out than was recorded in). */
  onHand: zDecimal,
  /** onHand × the average (12 decimals); null without a price yet. */
  value: sensitive(zDecimal.nullable(), 'cost'),
  /** The business day of its last finalized count (its first count included), null when none. */
  lastCountedOn: zBusinessDate.nullable(),
})
export type StockBranchDto = z.infer<typeof stockBranchDto>

export const stockItemDto = z.object({
  material: stockMaterialDto,
  /** The day of its first count: stock is tracked from it. */
  trackedFrom: zBusinessDate,
  /** On hand in the branches listed, in base units. */
  onHand: zDecimal,
  /** The stock average per one of the material's unit (D-006: one for the whole business). */
  avgPerUnit: sensitive(zDecimal.nullable(), 'cost'),
  /**
   * What the stock in the branches listed is worth: the stock's value for a member who sees every
   * branch, else the branches' values added; null without a price yet.
   */
  value: sensitive(zDecimal.nullable(), 'cost'),
  /** Each branch listed (the caller's, or the one asked for), by name. */
  branches: z.array(stockBranchDto),
})
export type StockItemDto = z.infer<typeof stockItemDto>

/** A live branch the caller works in, for branch pickers and filters. */
export const stockListBranchDto = z.object({ id: zUuid, name: z.string() })
export type StockListBranchDto = z.infer<typeof stockListBranchDto>

/**
 * `stock.list`: by name; `nextCursor` null on the last page. `branches`: the business's live branches
 * in the caller's branches, by name, whatever the page or filter (a member without the branches
 * setting picks from it).
 */
export const stockListDto = withMeta(
  z.object({
    items: z.array(stockItemDto),
    nextCursor: z.string().nullable(),
    branches: z.array(stockListBranchDto),
  }),
)
export type StockListDto = z.infer<typeof stockListDto>

/** `stock.untracked`: live materials not tracked yet, by name (to start tracking them). */
export const stockUntrackedInput = z
  .object({
    search: z.string().trim().max(CATALOG_SEARCH_MAX_LENGTH).optional(),
    cursor: pageCursor,
    limit: z.int().min(1).max(STOCK_PAGE_SIZE_MAX).default(STOCK_PAGE_SIZE),
  })
  .prefault({})
export type StockUntrackedInput = z.input<typeof stockUntrackedInput>

export const untrackedMaterialDto = z.object({
  material: stockMaterialDto,
  /** A draft first count it is already on (the newest), null when none. */
  openingDraftId: zUuid.nullable(),
})
export type UntrackedMaterialDto = z.infer<typeof untrackedMaterialDto>

export const stockUntrackedDto = z.object({
  items: z.array(untrackedMaterialDto),
  nextCursor: z.string().nullable(),
})
export type StockUntrackedDto = z.infer<typeof stockUntrackedDto>

/** `stock.card`: a tracked material's movements, newest business day first. */
export const stockCardInput = z.object({
  materialId: zUuid,
  /** Only this branch (one of the caller's; FORBIDDEN otherwise). */
  locationId: zUuid.optional(),
  cursor: pageCursor,
  limit: z.int().min(1).max(STOCK_CARD_PAGE_SIZE_MAX).default(STOCK_CARD_PAGE_SIZE),
})
export type StockCardInput = z.input<typeof stockCardInput>

export const stockCardEntryDto = z.object({
  id: zUuid,
  businessDate: zBusinessDate,
  locationId: zUuid,
  locationName: z.string(),
  kind: stockMovementKindDto,
  /** A reversal: the kind of movement it reverses. */
  reversesKind: stockMovementKindDto.nullable(),
  /** In base units, signed (+ in, − out); a first count's row: counted − what the book said. */
  qty: zDecimal,
  /** On hand after it (in the branch asked for, or the caller's branches), by business day. */
  runningQty: zDecimal,
  /** A count's row (and its reversal): what its line counted, in base units. */
  countedQty: zDecimal.nullable(),
  /** What it moved the stock's value by (value − adjustment, D-109), signed. */
  valueChange: sensitive(zDecimal, 'cost'),
  /** The average or price it moved at, per base unit; null without one. */
  unitCost: sensitive(zDecimal.nullable(), 'cost'),
  /**
   * Where it comes from: a purchase (also the purchase a supplier return or credit note belongs to,
   * whose page shows it), a supplier return or credit note, or a count.
   */
  purchaseId: zUuid.nullable(),
  returnId: zUuid.nullable(),
  countId: zUuid.nullable(),
  createdAt: isoTimestamp,
})
export type StockCardEntryDto = z.infer<typeof stockCardEntryDto>

export const stockCardDto = withMeta(
  z.object({
    material: stockMaterialDto,
    trackedFrom: zBusinessDate,
    /** On hand now (in the branch asked for, or the caller's branches). */
    onHand: zDecimal,
    /** Movements dated from the first count on (the running quantity counts every one). */
    entries: z.array(stockCardEntryDto),
    nextCursor: z.string().nullable(),
  }),
)
export type StockCardDto = z.infer<typeof stockCardDto>

// ---------------------------------------------------------------------------------------------------
// Counts (inventory.counts.enter / inventory.counts.manage)
// ---------------------------------------------------------------------------------------------------

/** A part of a counted line: a quantity (zero or more) in a standard unit or one of its packs. */
export const countPartInput = z
  .object({
    qty: zDecimal.refine(
      (value) => checkDecimal(value, 'quantity') === null && compareDecimal(value, '0') >= 0,
      { message: 'zero or more' },
    ),
    unit: standardUnitDto.nullish(),
    packId: zUuid.nullish(),
  })
  .refine((part) => (part.unit == null) !== (part.packId == null), {
    message: 'exactly one of unit and packId',
  })
export type CountPartInput = z.input<typeof countPartInput>

/**
 * `count.start` (counts.manage), idempotent on the client's `id`. A first count (`opening`) of
 * materials not tracked yet, in every active branch (a single-location business: its default
 * location); a `count` of one branch (null: the default location; another needs multi_location) of
 * some tracked materials, or `all` of them.
 */
export const startCountInput = z.discriminatedUnion('kind', [
  z.object({
    id: zUuid,
    kind: z.literal('opening'),
    businessDate: zBusinessDate,
    materialIds: materialIdsInput,
    note: noteInput,
  }),
  z.object({
    id: zUuid,
    kind: z.literal('count'),
    businessDate: zBusinessDate,
    locationId: zUuid.nullable().default(null),
    materialIds: z.union([z.literal('all'), materialIdsInput]),
    note: noteInput,
  }),
])
export type StartCountInput = z.input<typeof startCountInput>

/** `count.get`, `count.review`, `count.reverse`. */
export const countIdInput = z.object({ id: zUuid })
export type CountIdInput = z.input<typeof countIdInput>

/**
 * `count.finalize`, `count.discard`: the count's `version` as read (finalize: as `count.review`
 * returned it). Every change of a line (saved, cleared, added, taken off) moves it on, so a stale one
 * is CONFLICT: what is finalized is what was reviewed.
 */
export const countVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type CountVersionInput = z.input<typeof countVersionInput>

/** `count.list`: newest business day first. */
export const countListInput = z
  .object({
    /** Default: every count that was not discarded (and that the caller may see). */
    status: z.enum(['all', ...DOCUMENT_STATUSES]).default('all'),
    kind: stockCountKindDto.optional(),
    /** A branch's counts, and the first counts with a line there. */
    locationId: zUuid.optional(),
    cursor: pageCursor,
    limit: z.int().min(1).max(STOCK_PAGE_SIZE_MAX).default(STOCK_PAGE_SIZE),
  })
  .prefault({})
export type CountListInput = z.input<typeof countListInput>

/** `count.saveLine` (counts.enter or counts.manage): what was counted, the line's `version` as read. */
export const saveCountLineInput = z.object({
  countId: zUuid,
  lineId: zUuid,
  parts: z.array(countPartInput).min(1).max(COUNT_PARTS_MAX),
  version: z.int().positive(),
})
export type SaveCountLineInput = z.input<typeof saveCountLineInput>

/** `count.clearLine` ("count it again") and `count.removeLine` (counts.manage). */
export const countLineVersionInput = z.object({
  countId: zUuid,
  lineId: zUuid,
  version: z.int().positive(),
})
export type CountLineVersionInput = z.input<typeof countLineVersionInput>

/**
 * `count.addLines` (counts.manage): materials to add; one already on a first count gets the lines it
 * misses in live branches (a branch added since), one already on a count is skipped.
 */
export const addCountLinesInput = z.object({ countId: zUuid, materialIds: materialIdsInput })
export type AddCountLinesInput = z.input<typeof addCountLinesInput>

export const countPartDto = z.object({
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  packId: zUuid.nullable(),
  /** The pack's name (a pack removed since keeps its name here). */
  packName: z.string().nullable(),
})
export type CountPartDto = z.infer<typeof countPartDto>

export const countLineDto = z.object({
  id: zUuid,
  locationId: zUuid,
  /** Its branch's name (a first count has a line per branch; a counter sees no branch list). */
  locationName: z.string(),
  materialId: zUuid,
  /** What was typed; null until counted. */
  parts: z.array(countPartDto).nullable(),
  /** The same in base units; null until counted. */
  countedQty: zDecimal.nullable(),
  /** Who counted it (with a team; null otherwise) and when. */
  countedByName: z.string().nullable(),
  countedAt: isoTimestamp.nullable(),
  /** The caller counted it. */
  countedByMe: z.boolean(),
  version: z.int().positive(),
  /**
   * Finalized, for a member who manages counts only (absent otherwise): what the book said at the end
   * of the count's day, and counted − book. A first count's line: the book it replaced.
   */
  bookQty: zDecimal.optional(),
  differenceQty: zDecimal.optional(),
  /** Finalized, counts.manage and costs: what the difference moved the stock's value by. */
  differenceValue: sensitive(zDecimal, 'cost'),
  /** Finalized, counts.manage and costs: the average it was valued at, per base unit (null: none). */
  unitCost: sensitive(zDecimal.nullable(), 'cost'),
})
export type CountLineDto = z.infer<typeof countLineDto>

export const countDto = z.object({
  id: zUuid,
  kind: stockCountKindDto,
  /** `posted` is "finalized" on screen. */
  status: documentStatusDto,
  /** A count's branch; null for a first count (every branch). */
  locationId: zUuid.nullable(),
  locationName: z.string().nullable(),
  businessDate: zBusinessDate,
  note: z.string().nullable(),
  /** Its lines in the caller's branches, and how many of them are counted. */
  lineCount: z.int().nonnegative(),
  countedCount: z.int().nonnegative(),
  /** The materials its lines name, by name. */
  materials: z.array(stockMaterialDto),
  /** Its lines in the caller's branches, by material name then branch. */
  lines: z.array(countLineDto),
  /** Who started it, finalized it (with a team; null otherwise). */
  createdByName: z.string().nullable(),
  postedByName: z.string().nullable(),
  createdAt: isoTimestamp,
  postedAt: isoTimestamp.nullable(),
  reversedAt: isoTimestamp.nullable(),
  /** The reversal's business day (its own, or the first open day). */
  reversalDate: zBusinessDate.nullable(),
  version: z.int().positive(),
})
export type CountDto = z.infer<typeof countDto>

/** One count as withMeta() (sensitive fields may be removed; meta.redacted names them). */
export const countResultDto = withMeta(countDto)
export type CountResultDto = z.infer<typeof countResultDto>

/** `count.saveLine`, `count.clearLine`: the line as saved. */
export const countLineResultDto = withMeta(countLineDto)
export type CountLineResultDto = z.infer<typeof countLineResultDto>

export const countListItemDto = z.object({
  id: zUuid,
  kind: stockCountKindDto,
  status: documentStatusDto,
  locationId: zUuid.nullable(),
  locationName: z.string().nullable(),
  businessDate: zBusinessDate,
  note: z.string().nullable(),
  lineCount: z.int().nonnegative(),
  countedCount: z.int().nonnegative(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type CountListItemDto = z.infer<typeof countListItemDto>

/** `count.list`: newest business day first; `nextCursor` null on the last page. */
export const countListDto = z.object({
  items: z.array(countListItemDto),
  nextCursor: z.string().nullable(),
})
export type CountListDto = z.infer<typeof countListDto>

export const countReviewLineDto = z.object({
  lineId: zUuid,
  locationId: zUuid,
  locationName: z.string(),
  materialId: zUuid,
  materialName: z.string(),
  /** Null until counted. */
  countedQty: zDecimal.nullable(),
  /**
   * What the book says at the end of the count's day (on hand less what is dated after it); null for
   * a first count (nothing to compare yet).
   */
  expectedQty: zDecimal.nullable(),
  /** counted − expected; null until counted, and for a first count. */
  differenceQty: zDecimal.nullable(),
  /** What finalizing now would move the stock's value by (at today's average); null as above. */
  differenceValue: sensitive(zDecimal.nullable(), 'cost'),
})
export type CountReviewLineDto = z.infer<typeof countReviewLineDto>

export const countOpeningDto = z.object({
  materialId: zUuid,
  /** Counted in every branch together, in base units. */
  countedQty: zDecimal,
  /** That day's 90-day purchase average per one of the material's unit (D-115); null: no price. */
  avgPerUnit: sensitive(zDecimal.nullable(), 'cost'),
  /** What it starts at: counted × that average (0 without a price). */
  value: sensitive(zDecimal, 'cost'),
})
export type CountOpeningDto = z.infer<typeof countOpeningDto>

/** A first count's material with no line in a live branch (a branch added since it started). */
export const countMissingLineDto = z.object({
  locationId: zUuid,
  locationName: z.string(),
  materialId: zUuid,
})
export type CountMissingLineDto = z.infer<typeof countMissingLineDto>

/**
 * `count.review` (counts.manage): expected against counted, before finalizing; a draft only
 * (DOCUMENT_POSTED once finalized: its results are the line fields `count.get` returns).
 */
export const countReviewDto = withMeta(
  z.object({
    id: zUuid,
    kind: stockCountKindDto,
    status: documentStatusDto,
    businessDate: zBusinessDate,
    lines: z.array(countReviewLineDto),
    /** Lines not counted yet (finalizing needs none). */
    notCounted: z.int().nonnegative(),
    /** A first count: what each material starts at once finalized (as of now); empty for a count. */
    openings: z.array(countOpeningDto),
    /**
     * A first count: each of its materials in a live branch (of the caller's) with no line, by
     * material then branch; `count.addLines` with that material brings them (finalizing needs none).
     * Empty for a count.
     */
    missingLines: z.array(countMissingLineDto),
    /** The count's version: `count.finalize` sends it (CONFLICT when a line changed since). */
    version: z.int().positive(),
  }),
)
export type CountReviewDto = z.infer<typeof countReviewDto>
