// Stored values of the sales tables of M3 Step 2 (docs/DATA_MODEL.md §6: sales_channels, sales,
// sale_lines, sale_line_materials). The database CHECK constraints list the same values; pure code
// (contracts, the API, the app) reads them from here. The amounts of a sale come from computeSale
// (documents/sale.ts) and its cost from saleLineCost (costing/sale-cost.ts).

/**
 * `sales_channels.kind`: how a business sells (one table for every way, the plan's Step 2). A
 * `delivery_app` or a `marketplace` keeps a part of each sale (its commission, `fee_percent`, D-223);
 * the others keep nothing.
 */
export const SALES_CHANNEL_KINDS = [
  'shop',
  'messages',
  'website',
  'delivery_app',
  'marketplace',
  'other',
] as const
export type SalesChannelKind = (typeof SALES_CHANNEL_KINDS)[number]

/**
 * The channels a new business starts with, from its Smart Setup answers (`sales_channels`): walk-in
 * customers → "Shop", messages → "WhatsApp & phone", online → "Online"; one "Direct" channel when
 * none of these was chosen (D-226). Named in the business's language by the i18n keys
 * `setup.sales_channels.<key>`, then plain data.
 */
export const STARTER_SALES_CHANNELS = [
  { key: 'shop', kind: 'shop' },
  { key: 'messages', kind: 'messages' },
  { key: 'online', kind: 'website' },
  { key: 'direct', kind: 'other' },
] as const satisfies readonly { key: string; kind: SalesChannelKind }[]
export type StarterSalesChannel = (typeof STARTER_SALES_CHANNELS)[number]['key']

/**
 * The ready-made channels of "Add a channel" (their names are brand names, in the app's messages):
 * the delivery apps and marketplaces UAE businesses sell through. A preset is only a name and a kind;
 * once added it is plain data like any other channel.
 */
export const SALES_CHANNEL_PRESETS = [
  { key: 'talabat', kind: 'delivery_app' },
  { key: 'deliveroo', kind: 'delivery_app' },
  { key: 'careem', kind: 'delivery_app' },
  { key: 'noon_food', kind: 'delivery_app' },
  { key: 'keeta', kind: 'delivery_app' },
  { key: 'noon', kind: 'marketplace' },
  { key: 'amazon', kind: 'marketplace' },
] as const satisfies readonly { key: string; kind: SalesChannelKind }[]
export type SalesChannelPreset = (typeof SALES_CHANNEL_PRESETS)[number]['key']

/**
 * `sales.source`: how a sale came in. M3 Step 2: Today's sales (`day_sheet`, one sheet per member,
 * day or days, channel and branch, Q10) and One sale (`single`, a job or one customer). M3 Step 4: a
 * file imported (`import`: one sale per day × branch × channel, a summary's days on its last day).
 * M3 Step 5: an order delivered (`order`: posted on its delivery day, reversed by undoing the
 * delivery) and a refund (`refund`: a negative sale of the sale it takes back, by quantity or amount).
 * M3 Step 8: an issued invoice (`invoice`: posted on its supply date unless its sale counts elsewhere,
 * Q3) and an issued credit note (`credit_note`: a negative sale on its issue date).
 */
export const SALE_SOURCES = [
  'day_sheet',
  'single',
  'import',
  'order',
  'refund',
  'invoice',
  'credit_note',
] as const
export type SaleSource = (typeof SALE_SOURCES)[number]

/**
 * `sale_imports.status` and `channel_statements.status`: a draft until finalized; `reversed` once
 * taken back whole (an import's every day: its file may then be imported again).
 */
export const SALE_IMPORT_STATUSES = ['draft', 'posted', 'reversed'] as const
export type SaleImportStatus = (typeof SALE_IMPORT_STATUSES)[number]

/** Days already imported when an import is finalized: skipped (the default) or replaced (Q15). */
export const IMPORT_OVERLAPS = ['skip', 'replace'] as const
export type ImportOverlap = (typeof IMPORT_OVERLAPS)[number]

/** The most a sold line's quantity may be (the DTO caps it; the column is numeric(24,6)). */
export const SALE_LINE_QTY_MAX = '1000000000'
