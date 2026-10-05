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
 * day or days, channel and branch, Q10) and One sale (`single`, a job or one customer). Later steps
 * add `import`, `order`, `invoice` and `credit_note`.
 */
export const SALE_SOURCES = ['day_sheet', 'single'] as const
export type SaleSource = (typeof SALE_SOURCES)[number]

/** The most a sold line's quantity may be (the DTO caps it; the column is numeric(24,6)). */
export const SALE_LINE_QTY_MAX = '1000000000'
