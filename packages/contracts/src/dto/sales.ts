import {
  checkDecimal,
  compareDecimal,
  CREDIT_BY,
  DOCUMENT_STATUSES,
  PAYMENT_STATES,
  SALE_COST_BASES,
  SALE_LINE_KINDS,
  SALE_LINE_QTY_MAX,
  SALE_MATERIAL_BASES,
  SALE_SOURCES,
  SALES_CHANNEL_KINDS,
  VAT_CATEGORIES,
} from '@bizcost/domain'
import { z } from 'zod'
import { REFUND_LINES_MAX } from '../customers'
import { withMeta } from '../envelope'
import { DOCUMENT_PAGE_SIZE, DOCUMENT_PAGE_SIZE_MAX } from '../purchasing'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import {
  DELIVERY_AREA_MAX_LENGTH,
  MEMBER_LOCATIONS_MAX,
  SALE_LINE_DESCRIPTION_MAX_LENGTH,
  SALE_LINES_MAX,
  SALES_CHANNEL_NAME_MAX_LENGTH,
} from '../sales'
import { sensitive } from '../sensitivity'
import { nameInput, standardUnitDto } from './catalog'
import {
  discountDto,
  discountInput,
  moneyInput,
  notesInput,
  percentInput,
  positiveMoneyInput,
  settlementMethodDto,
} from './purchases'
import { optionalLine } from './suppliers'

// Sales (ROADMAP.md M3 Step 2; docs/DATA_MODEL.md §6; D-219–D-222, D-225–D-232): the business's sales
// channels, Today's sales (one sheet per member, day or days, channel and branch) and One sale, posted
// with the cost of what was sold frozen on the sale's day. Decimals are strings (Arabic-Indic digits
// accepted on input), business days YYYY-MM-DD, timestamps ISO strings.
//
// Prices and the sale's amounts are not sensitive (a price is shown to every member who sees products,
// D-187); seeing every sale, and so the sales totals, is a permission (`sales.documents.view`), not a
// redaction. Sensitive (`cost`, redacted for members without the costs switch): a channel's commission
// %, a sale's delivery cost (but the member who entered the sale reads what they typed in
// `ownDeliveryCost`, D-181), and the cost snapshot of each line (its cost basis, cost, time cost and
// its materials). Cost outputs are unbounded decimals: a cost is never too large to answer (D-209).

const isoTimestamp = z.iso.datetime({ offset: true })

/** A decimal string of any length (an output: a frozen cost is unbounded numeric, D-209). */
const unboundedDecimal = z.string().regex(/^-?\d+(?:\.\d+)?$/)

/** A sold quantity: more than zero, at most SALE_LINE_QTY_MAX, numeric(24,6). */
export const saleQtyInput = zDecimal.refine(
  (v) =>
    checkDecimal(v, 'quantity') === null &&
    compareDecimal(v, '0') > 0 &&
    compareDecimal(v, SALE_LINE_QTY_MAX) <= 0,
  { message: `more than zero and at most ${SALE_LINE_QTY_MAX}` },
)

const uniqueIds = (items: readonly { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length

export const salesChannelKindDto = z.enum(SALES_CHANNEL_KINDS)
export const saleSourceDto = z.enum(SALE_SOURCES)
export const saleStatusDto = z.enum(DOCUMENT_STATUSES)

// ---------------------------------------------------------------------------------------------------
// Sales channels (module sales; any sales key to list, sales.channels.manage to change)
// ---------------------------------------------------------------------------------------------------

/** `channel.list`: by name; active ones by default. */
export const channelListInput = z
  .object({ status: z.enum(['active', 'archived', 'all']).default('active') })
  .prefault({})
export type ChannelListInput = z.input<typeof channelListInput>

const channelFields = {
  name: nameInput(SALES_CHANNEL_NAME_MAX_LENGTH),
  kind: salesChannelKindDto,
  /**
   * What the app keeps of each sale before VAT, from the contract (Q8), 0–100. Only a member who sees
   * costs sends it (FORBIDDEN otherwise, even null); left out, an update keeps it.
   */
  feePercent: percentInput.nullish(),
}

/** `channel.create`: idempotent on the client's `id`. */
export const createChannelInput = z.object({ id: zUuid, ...channelFields })
export type CreateChannelInput = z.input<typeof createChannelInput>

/** `channel.update`: the whole channel, `version` as read (the commission left out is kept). */
export const updateChannelInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  ...channelFields,
})
export type UpdateChannelInput = z.input<typeof updateChannelInput>

export const salesChannelDto = z.object({
  id: zUuid,
  name: z.string(),
  kind: salesChannelKindDto,
  /** What the app keeps of each sale before VAT (%); null: not entered. */
  feePercent: sensitive(zDecimal.nullable(), 'cost'),
  /** When it was archived (hidden from pickers); null while active. */
  archivedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type SalesChannelDto = z.infer<typeof salesChannelDto>

export const salesChannelResultDto = withMeta(salesChannelDto)
export type SalesChannelResultDto = z.infer<typeof salesChannelResultDto>

/** `channel.list`: by name (case ignored). */
export const salesChannelListDto = withMeta(z.object({ items: z.array(salesChannelDto) }))
export type SalesChannelListDto = z.infer<typeof salesChannelListDto>

// ---------------------------------------------------------------------------------------------------
// Sales (module sales; sales.documents.view / manage / post / reverse)
// ---------------------------------------------------------------------------------------------------

/**
 * Something sold: a product or service of the business (NOT_FOUND otherwise), `qty` in its unit,
 * `unitPrice` per unit as the product's prices are typed (before VAT, or with VAT when the product's
 * price includes it, D-121), and its own discount. `description`: the product's name when left out
 * (editable, D-002).
 */
export const saleItemLineInput = z.object({
  kind: z.literal('item'),
  id: zUuid,
  productId: zUuid,
  description: optionalLine(SALE_LINE_DESCRIPTION_MAX_LENGTH),
  qty: saleQtyInput,
  unitPrice: moneyInput,
  discount: discountInput.nullish(),
})

/**
 * Delivery charged to the customer (only on a sale with delivery): the amount, before VAT unless
 * `amountIncludesVat` (a VAT-registered business only: CAPABILITY_DISABLED otherwise). Standard-rated
 * for a VAT-registered business.
 */
export const saleDeliveryLineInput = z.object({
  kind: z.literal('delivery'),
  id: zUuid,
  description: optionalLine(SALE_LINE_DESCRIPTION_MAX_LENGTH),
  amount: moneyInput,
  amountIncludesVat: z.boolean().default(false),
})

export const saleLineInput = z.discriminatedUnion('kind', [
  saleItemLineInput,
  saleDeliveryLineInput,
])

/**
 * Something sold that is no saved product or service (M3 Step 7, Q21): typed on a quotation and carried
 * to its order, never entered as a sale of its own. Its title is required; its unit, VAT category
 * (standard by default) and whether its price includes VAT (a VAT-registered business only:
 * CAPABILITY_DISABLED otherwise) are as typed. It counts in sales and carries its share and fees, with
 * no materials.
 */
export const saleTypedLineInput = z.object({
  kind: z.literal('typed'),
  id: zUuid,
  description: optionalLine(SALE_LINE_DESCRIPTION_MAX_LENGTH).refine((value) => value !== null, {
    message: 'a typed line needs its title',
  }),
  qty: saleQtyInput,
  unit: standardUnitDto.nullish().transform((value) => value ?? null),
  unitPrice: moneyInput,
  priceIncludesVat: z.boolean().default(false),
  vatCategory: z.enum(VAT_CATEGORIES).default('standard'),
  discount: discountInput.nullish(),
})
export type SaleTypedLineInput = z.input<typeof saleTypedLineInput>
export type SaleLineInput = z.input<typeof saleLineInput>

const saleFields = {
  /** The sale's day (never after today: FUTURE_DATE); a sheet for several days: its last day. */
  businessDate: zBusinessDate,
  /** Today's sales for several days within one month: the first day (before `businessDate`). */
  periodFrom: zBusinessDate.nullable().default(null),
  /**
   * Where it was sold. Another than the default location needs multi_location
   * (CAPABILITY_DISABLED), and one of the member's branches when they are limited (FORBIDDEN); null:
   * the default location.
   */
  locationId: zUuid.nullable().default(null),
  /** The channel (a live one of the business); null: its only active channel. */
  channelId: zUuid.nullable().default(null),
  deliveryNeeded: z.boolean().default(false),
  /** Only with delivery. */
  deliveryArea: optionalLine(DELIVERY_AREA_MAX_LENGTH),
  /**
   * What the delivery actually cost the business (only with delivery), typed by the member who enters
   * the sale. Left out, an update keeps it; changing another member's (or someone else's since) needs
   * the costs switch (FORBIDDEN otherwise).
   */
  deliveryCost: moneyInput.nullish(),
  notes: notesInput,
  /**
   * One sale only (M3 Step 5): the customer (a live one of the business; null: none named). Needs
   * Customers on (MODULE_DISABLED) and a key that names customers.
   */
  customerId: zUuid.nullable().default(null),
  /**
   * One sale only: "They'll pay later" (Q17): what it comes to is owed by its customer (it needs one)
   * until paid through customer payments. Otherwise a sale is paid when made. Needs Payments on.
   */
  payLater: z.boolean().default(false),
  /** In their order on the sale; every item line names something sold (Q9). Ids are client UUIDv7s. */
  lines: z
    .array(saleLineInput)
    .max(SALE_LINES_MAX)
    .default([])
    .refine(uniqueIds, { message: 'duplicate line id' })
    .refine((lines) => lines.filter((l) => l.kind === 'delivery').length <= 1, {
      message: 'one delivery line at most',
    }),
}

/** Delivery's fields go with a sale that has delivery. */
function deliveryFits(sale: {
  deliveryNeeded: boolean
  deliveryArea: string | null
  deliveryCost?: string | null | undefined
  lines: readonly { kind: string }[]
}): boolean {
  if (sale.deliveryNeeded) return true
  return (
    sale.deliveryArea === null &&
    (sale.deliveryCost === undefined || sale.deliveryCost === null) &&
    sale.lines.every((line) => line.kind !== 'delivery')
  )
}
const deliveryMessage = { message: 'delivery area, cost and charge go with a sale with delivery' }

/** "They'll pay later" needs the customer who will. */
const payLaterFits = (sale: { payLater: boolean; customerId: string | null }) =>
  !sale.payLater || sale.customerId !== null
const payLaterMessage = { message: 'payLater needs the customer' }

/** How a sale may be entered: Today's sales or One sale (orders, refunds and imports post their own). */
export const enteredSaleSourceDto = z.enum(['day_sheet', 'single'])

/**
 * `sale.create` (a draft): idempotent on the client's `id`. `day_sheet`: Today's sales, items only,
 * no delivery, no customer; one live sheet per member × days × channel × location (CONFLICT for a
 * second; ask `sale.daySheet`, which opens it). `periodFrom` only on a day sheet.
 */
export const createSaleInput = z
  .object({ id: zUuid, source: enteredSaleSourceDto, ...saleFields })
  .refine(deliveryFits, deliveryMessage)
  .refine(payLaterFits, payLaterMessage)
  .refine(
    (sale) => (sale.source === 'day_sheet' ? !sale.deliveryNeeded : sale.periodFrom === null),
    { message: 'a day sheet has no delivery; only a day sheet covers several days' },
  )
  .refine((sale) => sale.source === 'single' || (sale.customerId === null && !sale.payLater), {
    message: 'a day sheet names no customer',
  })
export type CreateSaleInput = z.input<typeof createSaleInput>

/** `sale.update` (a draft only): the whole sale, `version` as read. Its source never changes. */
export const updateSaleInput = z
  .object({ id: zUuid, version: z.int().positive(), ...saleFields })
  .refine(deliveryFits, deliveryMessage)
  .refine(payLaterFits, payLaterMessage)
export type UpdateSaleInput = z.input<typeof updateSaleInput>

/** One line a refund takes back: by quantity (`qty`) or by amount (`amount`), as the refund says. */
export const refundLineInput = z.object({
  /** The line of the sale refunded. */
  lineId: zUuid,
  /** By quantity: how much of it comes back (at most what is left). */
  qty: saleQtyInput.optional(),
  /** By amount: what it is cut by, typed like its prices (at most what is left of its value). */
  amount: moneyInput.optional(),
})

/**
 * `sale.refund` (M3 Step 5): a negative sale linked to the finalized sale it refunds (`saleId`), or to
 * a delivered order's sale (`orderId`): by quantity (goods returned: it takes off the line's frozen
 * cost of what was sold for that quantity) or by amount (a price cut: it takes off no cost). Never more
 * than is left of a line (EXCEEDS_SALE); each later refund starts from what the earlier ones left. Its
 * day (default today) is never after today nor on or before the books-closed date. `payment`: the
 * money given back with it, on the order or the sale "they'll pay later" (payments.customers.record).
 * Idempotent on the client's `id`.
 */
export const refundSaleInput = z
  .object({
    id: zUuid,
    saleId: zUuid.optional(),
    orderId: zUuid.optional(),
    by: z.enum(CREDIT_BY),
    businessDate: zBusinessDate.optional(),
    lines: z
      .array(refundLineInput)
      .min(1)
      .max(REFUND_LINES_MAX)
      .refine((lines) => new Set(lines.map((l) => l.lineId)).size === lines.length, {
        message: 'a line twice',
      }),
    notes: notesInput,
    payment: z
      .object({
        id: zUuid,
        method: settlementMethodDto,
        amount: positiveMoneyInput,
      })
      .nullish()
      .transform((value) => value ?? null),
  })
  .refine((input) => (input.saleId === undefined) !== (input.orderId === undefined), {
    message: 'exactly one of saleId and orderId',
  })
  .refine(
    (input) =>
      input.lines.every((l) =>
        input.by === 'quantity'
          ? l.qty !== undefined && l.amount === undefined
          : l.amount !== undefined && l.qty === undefined,
      ),
    { message: 'by quantity: each line its qty; by amount: each line its amount' },
  )
export type RefundSaleInput = z.input<typeof refundSaleInput>

/**
 * What a document "they'll pay later" (an order, or a sale with payLater) is paid and owes (Q17; one
 * figure per obligation, A2): it comes to `total` (an order: 0 once cancelled), less its refunds
 * (`credited`, with VAT); `paid` is the payments that stand, `refunded` the money given back; `owed`
 * what is still owed, `overpaid` what was paid beyond it ("money back to the customer"). Never a field
 * named balance.
 */
export const documentPaymentStateDto = z.object({
  state: z.enum(PAYMENT_STATES),
  total: zDecimal,
  credited: zDecimal,
  paid: zDecimal,
  refunded: zDecimal,
  owed: zDecimal,
  overpaid: zDecimal,
})
export type DocumentPaymentStateDto = z.infer<typeof documentPaymentStateDto>

/** A refund of a sale (sale.refund): its day, how it took back, and what it came to. */
export const refundSummaryDto = z.object({
  id: zUuid,
  businessDate: zBusinessDate,
  by: z.enum(CREDIT_BY),
  /** What it gives back (with VAT), as a positive amount. */
  total: zDecimal,
  /** `reversed`: taken back itself. */
  status: z.enum(['posted', 'reversed']),
})
export type RefundSummaryDto = z.infer<typeof refundSummaryDto>

/** `sale.get`, `sale.reverse`. */
export const saleIdInput = z.object({ id: zUuid })
export type SaleIdInput = z.input<typeof saleIdInput>

/** `sale.post`, `sale.discard`: the draft's `version` as read. */
export const saleVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type SaleVersionInput = z.input<typeof saleVersionInput>

/** `sale.correct`: reverse a posted sale and open a copy of it as a new draft (`newId`). */
export const correctSaleInput = z.object({ id: zUuid, newId: zUuid })
export type CorrectSaleInput = z.input<typeof correctSaleInput>

/**
 * `sale.fillDeliveryCost`: what the delivery of a finalized sale (with delivery, whose delivery cost
 * was not entered) actually cost, once (D-230). Needs the costs switch.
 */
export const fillDeliveryCostInput = z.object({ id: zUuid, deliveryCost: moneyInput })
export type FillDeliveryCostInput = z.input<typeof fillDeliveryCostInput>

/**
 * `sale.list`: newest business day first. A member without "see every sale" lists only the sales they
 * entered; a member limited to branches only those branches' (Q12). The search is in the lines' names
 * (product names as sold), never in an amount (D-209).
 */
export const saleListInput = z
  .object({
    status: z.enum(['all', ...DOCUMENT_STATUSES]).default('all'),
    source: saleSourceDto.optional(),
    channelId: zUuid.optional(),
    locationId: zUuid.optional(),
    /** A customer's sales (M3 Step 5): those that name them (an order's sale and refunds too). */
    customerId: zUuid.optional(),
    /** Business days from and to (both included). */
    from: zBusinessDate.optional(),
    to: zBusinessDate.optional(),
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(DOCUMENT_PAGE_SIZE_MAX).default(DOCUMENT_PAGE_SIZE),
  })
  .prefault({})
export type SaleListInput = z.input<typeof saleListInput>

/**
 * `sale.daySheet`: Today's sales of the caller for a day (or several days of one month), a channel and
 * a branch: their own sheet when they have one (draft or finalized), the branch's products and their
 * last prices. Null channel: the business's only active channel; null location: the default one.
 */
export const daySheetInput = z.object({
  businessDate: zBusinessDate,
  periodFrom: zBusinessDate.nullable().default(null),
  channelId: zUuid.nullable().default(null),
  locationId: zUuid.nullable().default(null),
})
export type DaySheetInput = z.input<typeof daySheetInput>

const cost = () => sensitive(unboundedDecimal.nullable(), 'cost')

/** What a sold line used of one material, frozen at posting (D-222). */
export const saleLineMaterialDto = z.object({
  materialId: zUuid,
  /** The material's name as it is now. */
  materialName: z.string(),
  /** What the line used, in the material's base unit (g, ml, piece…). */
  baseQty: unboundedDecimal,
  /** The average per base unit it was costed at; null: no price yet. */
  unitCost: unboundedDecimal.nullable(),
  /** baseQty × the average; null: no price yet (filled once by the first purchase that prices it). */
  cost: unboundedDecimal.nullable(),
  /** Which purchases priced it; null: no price yet. */
  basis: z.enum(SALE_MATERIAL_BASES).nullable(),
})
export type SaleLineMaterialDto = z.infer<typeof saleLineMaterialDto>

export const saleLineDto = z.object({
  id: zUuid,
  kind: z.enum(SALE_LINE_KINDS),
  productId: zUuid.nullable(),
  /** The product's name when the line was saved (editable), or the delivery's text. */
  description: z.string().nullable(),
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  unitPrice: zDecimal,
  /** Whether its price was taken as including VAT (never without VAT registration). */
  priceIncludesVat: z.boolean(),
  discount: discountDto.nullable(),
  /** Null for a business not registered for VAT. */
  vatCategory: z.enum(VAT_CATEGORIES).nullable(),
  vatRate: zDecimal.nullable(),
  subtotal: zDecimal,
  /** Its own discount as an amount. */
  lineDiscount: zDecimal,
  /** Before VAT, after its discount: its sales. */
  net: zDecimal,
  vat: zDecimal,
  total: zDecimal,
  /** Posted: what one unit sold uses (`recipe`, `resale` or `none`); null for a draft. */
  costBasis: sensitive(z.enum(SALE_COST_BASES).nullable(), 'cost'),
  /** Posted: what the line cost; null for a draft, with nothing to cost, or while a price is missing. */
  cost: cost(),
  /**
   * Posted, without a team: the owner's minutes for the line (minutes for one unit × qty). A `cost`
   * like the product's own minutes (D-119): a sale finalized before the business had a team keeps them.
   */
  timeMinutes: cost(),
  /**
   * Posted: a product (not a service) sold with nothing to cost while Materials is on, so what it used
   * is not known yet: its profit is incomplete (D-223's `no_recipe`). False for a service, with
   * Materials off, or once it has what it uses.
   */
  noRecipe: sensitive(z.boolean(), 'cost'),
  /** Posted, without a team: the owner's time cost; null until the hourly rate is set. */
  timeCost: cost(),
  /**
   * Posted: one row per material (the expected usage Phase 4 reads). Null for a draft, and for a
   * member who may not see what goes into each product (products.recipes.view, D-150).
   */
  materials: sensitive(z.array(saleLineMaterialDto).nullable(), 'cost'),
  /** A refund's line: the line of the sale it takes back. */
  refundOfLineId: zUuid.nullable(),
  /**
   * A finalized sale's line (not a refund's): what its refunds that stand leave of it, as positive
   * amounts (`typed`: its value as its prices are typed, with VAT when they include it). Null for a
   * draft or a refund.
   */
  left: z
    .object({
      qty: zDecimal,
      net: zDecimal,
      vat: zDecimal,
      total: zDecimal,
      typed: zDecimal,
    })
    .nullable(),
})
export type SaleLineDto = z.infer<typeof saleLineDto>

export const saleDto = z.object({
  id: zUuid,
  status: saleStatusDto,
  source: saleSourceDto,
  businessDate: zBusinessDate,
  periodFrom: zBusinessDate.nullable(),
  locationId: zUuid,
  /** The location's name as it is now. */
  locationName: z.string(),
  channelId: zUuid,
  /** The channel's name and kind as they are now. */
  channelName: z.string(),
  channelKind: salesChannelKindDto,
  /** The VAT registration it was made under (frozen at posting). */
  vatRegistered: z.boolean(),
  /** ISO 4217 (the business's currency). */
  currency: z.string(),
  subtotal: zDecimal,
  /** Its lines' discounts. */
  discountTotal: zDecimal,
  /** Before VAT: its sales. */
  netTotal: zDecimal,
  vatTotal: zDecimal,
  total: zDecimal,
  deliveryNeeded: z.boolean(),
  deliveryArea: z.string().nullable(),
  /** What the delivery actually cost the business; null: not entered (D-230 fills it once). */
  deliveryCost: sensitive(zDecimal.nullable(), 'cost'),
  /** The delivery cost of a sale the caller entered themselves (D-181); null on anyone else's. */
  ownDeliveryCost: zDecimal.nullable(),
  notes: z.string().nullable(),
  lines: z.array(saleLineDto),
  /** Who entered it (their name in the business as it is now); null without a team. */
  enteredByName: z.string().nullable(),
  /** The caller entered it. */
  mine: z.boolean(),
  postedAt: isoTimestamp.nullable(),
  reversedAt: isoTimestamp.nullable(),
  /** The reversal's business day: the sale's own, or the first open day when its day is closed. */
  reversalBusinessDate: zBusinessDate.nullable(),
  /** A draft made by "correct": the reversed sale it replaces. */
  copiedFromId: zUuid.nullable(),
  /**
   * An imported sale (source import, M3 Step 4): the import it came from. It is reversed through
   * its import (a day, or the whole file), never on its own.
   */
  importId: zUuid.nullable(),
  /** The customer it names (M3 Step 5), their name as it is now and their phone's last 4 digits. */
  customerId: zUuid.nullable(),
  customerName: z.string().nullable(),
  customerPhoneLast4: z.string().nullable(),
  /** "They'll pay later": owed by its customer until paid (customer payments). */
  payLater: z.boolean(),
  /** An order's sale (source order), and a refund of one: the order and its number. */
  orderId: zUuid.nullable(),
  orderNumber: z.string().nullable(),
  /** A refund: the sale it takes back, and how (by quantity or amount). */
  refundOfId: zUuid.nullable(),
  refundBy: z.enum(CREDIT_BY).nullable(),
  /**
   * M3 Step 8: the issued invoice this sale counts (source `invoice`), the one its credit note corrects
   * (source `credit_note`), or the one made from it (a One sale): its id and number; null otherwise.
   */
  invoice: z.object({ id: zUuid, number: z.string() }).nullable(),
  /** M3 Step 8: a credit note's sale: the credit note's number. */
  creditNoteNumber: z.string().nullable(),
  /** The refunds of this sale, newest first (none for a draft or a refund). */
  refunds: z.array(refundSummaryDto),
  /**
   * A sale "they'll pay later": what it is paid and owes (null otherwise, and without
   * payments.customers.view or with Payments off). An order's sale owes nothing: its order does.
   */
  payment: documentPaymentStateDto.nullable(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type SaleDto = z.infer<typeof saleDto>

/** One sale as withMeta() (its costs may be removed; meta.redacted names them). */
export const saleResultDto = withMeta(saleDto)
export type SaleResultDto = z.infer<typeof saleResultDto>

export const saleListItemDto = z.object({
  id: zUuid,
  status: saleStatusDto,
  source: saleSourceDto,
  businessDate: zBusinessDate,
  periodFrom: zBusinessDate.nullable(),
  locationId: zUuid,
  channelId: zUuid,
  channelName: z.string(),
  currency: z.string(),
  netTotal: zDecimal,
  vatTotal: zDecimal,
  total: zDecimal,
  /** How many items it sold (delivery lines are not counted). */
  lineCount: z.int().nonnegative(),
  /** The names of its first two items. */
  itemNames: z.array(z.string()),
  /** Who entered it; null without a team. */
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  /** M3 Step 5: its customer's name, its order's number, the sale a refund takes back. */
  customerName: z.string().nullable(),
  orderNumber: z.string().nullable(),
  /** M3 Step 8: the number of the invoice (source `invoice`) or credit note (`credit_note`) it is. */
  documentNumber: z.string().nullable(),
  refundOfId: zUuid.nullable(),
  payLater: z.boolean(),
  version: z.int().positive(),
})
export type SaleListItemDto = z.infer<typeof saleListItemDto>

/** One day of the list's days: what the sales (not reversed) that match the filters came to. */
export const saleDayTotalDto = z.object({
  businessDate: zBusinessDate,
  netTotal: zDecimal,
  total: zDecimal,
  /** Finalized sales counted (drafts are not sales yet). */
  count: z.int().nonnegative(),
})

/**
 * `sale.list`: newest business day first; `nextCursor` null on the last page. `dayTotals`: the days
 * of this page, each with every finalized sale of it that matches the filters (all members' sales:
 * the sales totals, H1), only for a member who sees every sale; null for one who sees only their own.
 */
export const saleListDto = z.object({
  items: z.array(saleListItemDto),
  nextCursor: z.string().nullable(),
  dayTotals: z.array(saleDayTotalDto).nullable(),
})
export type SaleListDto = z.infer<typeof saleListDto>

/** A product on the day sheet, with the price filled in. */
export const daySheetProductDto = z.object({
  productId: zUuid,
  name: z.string(),
  type: z.enum(['product', 'service']),
  unit: standardUnitDto,
  /** The last price the caller sold it at on this channel and branch, else its usual price. */
  price: zDecimal.nullable(),
  /** Whether its price includes VAT (never without VAT registration). */
  priceIncludesVat: z.boolean(),
  /** Null for a business not registered for VAT. */
  vatCategory: z.enum(VAT_CATEGORIES).nullable(),
})

/** A branch the caller may sell at (the day sheet's and One sale's branch picker). */
export const saleLocationDto = z.object({
  id: zUuid,
  name: z.string(),
  isDefault: z.boolean(),
})

/** A member's sheet for the same days, channel and branch (for members who see every sale). */
export const daySheetEntryDto = z.object({
  saleId: zUuid,
  status: saleStatusDto,
  /** Null without a team. */
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
})

export const daySheetDto = withMeta(
  z.object({
    businessDate: zBusinessDate,
    periodFrom: zBusinessDate.nullable(),
    locationId: zUuid,
    channelId: zUuid,
    channelName: z.string(),
    /** Today in the business's time zone (a sheet is never after it). */
    today: zBusinessDate,
    /** "Books closed up to" (nothing on or before it is finalized); null when open. */
    closedThrough: zBusinessDate.nullable(),
    /** The caller's own live sheet for these days, channel and branch (draft or finalized). */
    sheet: saleDto.nullable(),
    /** The branch's products: the caller's most sold of the last 30 days first, then by name. */
    products: z.array(daySheetProductDto),
    /**
     * Every live sheet for these days, channel and branch ("2 sheets for Shop on 8 Oct (Ali, Sara)"),
     * for a member who sees every sale; null for one who sees only their own.
     */
    sheets: z.array(daySheetEntryDto).nullable(),
    /**
     * The branches the caller may sell at (all of them, or the ones they are limited to, Q12): the
     * default first, then by name. Null for a business without branches (multi_location).
     */
    locations: z.array(saleLocationDto).nullable(),
    /**
     * An imported file already covers these days, channel and branch (M3 Step 4): its sales count too,
     * so the screen warns before the same sales are typed twice.
     */
    imported: z.boolean(),
  }),
)
export type DaySheetDto = z.infer<typeof daySheetDto>

// ---------------------------------------------------------------------------------------------------
// A member's branches (Q12; module sales, capabilities has_team and multi_location)
// ---------------------------------------------------------------------------------------------------

export const memberLocationsInput = z.object({ memberId: zUuid })
export type MemberLocationsInput = z.input<typeof memberLocationsInput>

/**
 * `member.locations`: the branches a member works in. Empty: all of them, the ones added later
 * included (D-054).
 */
export const memberLocationsDto = z.object({
  memberId: zUuid,
  locationIds: z.array(zUuid),
  /**
   * Whether the caller may change it: not the Owner, not the caller's own, and nothing beyond the
   * caller's own branches.
   */
  editable: z.boolean(),
  /** The member's permissions version: send it back with the change (CONFLICT when it moved on). */
  version: z.int().nonnegative(),
})
export type MemberLocationsDto = z.infer<typeof memberLocationsDto>

/** `member.updateLocations`: the branches, all of them (empty: every branch), `version` as read. */
export const updateMemberLocationsInput = z.object({
  memberId: zUuid,
  version: z.int().nonnegative(),
  locationIds: z
    .array(zUuid)
    .max(MEMBER_LOCATIONS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'a location twice' }),
})
export type UpdateMemberLocationsInput = z.input<typeof updateMemberLocationsInput>
