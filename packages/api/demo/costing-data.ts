import type {
  CreditBy,
  CustomerKind,
  Emirate,
  PaymentKind,
  PaymentMethod,
  PurchaseDocumentType,
  RunningCostFrequency,
  SalesChannelKind,
  SettlementMethod,
  StandardUnit,
  StarterCostCategory,
} from '@bizcost/domain'
import { lastMonth, type DemoDay } from './days'

// The data of each demo business: its Costing Core (M2: suppliers, materials, products & services,
// recipes, purchases, returns and credit notes, payments, running costs, expenses, the owner's time)
// and its sales (M3, Release A: channels, Today's sales and One sale, files imported, app statements,
// customers, orders with deposits, deliveries, payments and refunds). demo/costing.ts enters it through
// the API, dated back from the business's today (demo/days.ts): the first purchases are about 4 months
// old, so the 90-day average (D-115) leaves some out, and each business buys again in its last week.
// Running costs start 8 months back and expenses fall in the last few months, so the last full month's
// costs (D-202) hold both; the café's electricity bill, entered on the seed day for the month before,
// replaces that month's regular electricity. Last month's sales, orders and the fit-out's job materials
// are dated on days of last month (`lastMonth(day)`), so every persona shows a whole month of real
// profit whatever day the seed runs; this month's come from the days before the seed day. Names are in
// the business's language (one name, D-113). Every amount is a decimal string; prices move a little
// over time, so averages differ from the last price. Keys are stable: they make each record's id, so a
// second run finds what the first one made (a record added later gets a new key; D-185).

export { lastMonth, type DemoDay }

/** A quantity: a standard unit of the material (or of its cross factor), or one of its packs' keys. */
export type UnitOrPack = StandardUnit | (string & {})

export interface DemoPack {
  readonly key: string
  readonly name: string
  readonly qty: string
  /** 1 pack = qty of this standard unit, or of the pack with this key. */
  readonly of: UnitOrPack
}

export interface DemoMaterial {
  readonly key: string
  readonly name: string
  readonly unit: StandardUnit
  readonly packs?: readonly DemoPack[]
  /** 1 `unit` (another dimension) = qty `ofUnit` (the material's). */
  readonly cross?: readonly { unit: StandardUnit; qty: string; ofUnit: StandardUnit }[]
}

export interface DemoSupplier {
  readonly key: string
  readonly name: string
  readonly phone?: string
  readonly trn?: string
}

export interface DemoProduct {
  readonly key: string
  readonly name: string
  /** Default: product. */
  readonly type?: 'product' | 'service'
  readonly unit: StandardUnit
  /** The usual selling price (with VAT when priceIncludesVat). */
  readonly price: string
  readonly priceIncludesVat?: boolean
  /** A business without a team: the owner's minutes for one unit (D-119). */
  readonly ownerMinutes?: string
  /** Bought ready to sell (D-117): its material's key and how it is bought. */
  readonly resale?: { readonly key: string; readonly packs: readonly DemoPack[] }
}

export interface DemoRecipe {
  readonly product: string
  /** How many units of the product it makes (default 1). */
  readonly makes?: string
  readonly lines: readonly (readonly [material: string, qty: string, unit: UnitOrPack])[]
}

export interface DemoPurchase {
  readonly key: string
  readonly daysAgo: DemoDay
  readonly supplier?: string
  /** Default: a tax invoice for a VAT-registered business, else another invoice or receipt. */
  readonly document?: PurchaseDocumentType
  readonly payment: PaymentMethod
  readonly reference?: string
  /** A location other than the default one, by name. */
  readonly branch?: string
  /** Prices per purchase unit, before VAT on a tax invoice, as paid otherwise. */
  readonly lines: readonly (readonly [
    material: string,
    qty: string,
    unit: UnitOrPack,
    price: string,
  ])[]
}

export interface DemoReturn {
  readonly key: string
  readonly purchase: string
  readonly daysAgo: DemoDay
  readonly kind: 'return' | 'credit_note'
  readonly reference?: string
  readonly notes?: string
  /** Per material of the purchase: a quantity in its line's unit (return) or an amount (credit). */
  readonly lines: readonly (readonly [material: string, qtyOrAmount: string])[]
}

export interface DemoPayment {
  readonly key: string
  /** A purchase's or an expense's key. */
  readonly purchase?: string
  readonly expense?: string
  readonly daysAgo: DemoDay
  readonly method: SettlementMethod
  /** An amount, or everything still owed. */
  readonly amount: string | 'outstanding'
  readonly note?: string
}

/** A starter category (named in the business's language), or one the business added. */
export type DemoCategory = StarterCostCategory | { readonly name: string }

export interface DemoRunningCost {
  readonly key: string
  readonly name: string
  readonly category: DemoCategory
  readonly amount: string
  /** Default: monthly. */
  readonly frequency?: RunningCostFrequency
}

export interface DemoExpense {
  readonly key: string
  readonly daysAgo: DemoDay
  readonly category: DemoCategory
  readonly description: string
  /** Before VAT on a tax invoice, as paid otherwise. */
  readonly amount: string
  readonly document?: PurchaseDocumentType
  readonly payment: PaymentMethod
  readonly supplier?: string
  readonly reference?: string
  /** paid_by_member: the member's email. */
  readonly paidBy?: string
  /** The member who enters it (default: the owner); the owner finalizes it. */
  readonly enteredBy?: string
  /**
   * Sent for approval by who entered it (approval is turned on for it, a team only; D-164, D-180):
   * approved by this member and then finalized by the owner, or left waiting for approval.
   */
  readonly approval?: { readonly by: string } | 'waiting'
  /**
   * What it pays (D-216), said exactly when its category has a running cost: the key of the running
   * cost it is the bill of (it takes the place of that running cost's regular amount alone), or
   * 'extra' (it counts as itself, on top of the category's running costs). In any category (M3 Step
   * 3, Q8): the app fees of a channel (a channel the business adds, by its key, or a starter one by
   * its kind), which never count in the month's costs. The owner says it when he finalizes it.
   */
  readonly pays?: { readonly runningCost: string } | { readonly channelFees: string } | 'extra'
  /**
   * The month it is for, as months before the seed day's month (default: the category's own default,
   * D-194): a bonus paid today for last month says 1.
   */
  readonly monthsBack?: number
}

/** A sales channel the business adds (M3 Step 2): a delivery app or a marketplace. */
export interface DemoChannel {
  readonly key: string
  readonly name: string
  readonly kind: SalesChannelKind
  /** What it keeps of each sale, until a statement says what it kept (Q8). */
  readonly feePercent?: string
}

/** A payment by the customer: on an order or a sale "they'll pay later" (or money given back). */
export interface DemoCustomerPayment {
  readonly key: string
  readonly daysAgo: DemoDay
  readonly method: SettlementMethod
  /** An amount, or everything still owed. */
  readonly amount: string | 'outstanding'
  /** `refund`: money given back (a cancelled order's deposit). */
  readonly kind?: PaymentKind
}

/**
 * A sale (M3 Step 2): Today's sales (`day_sheet`, a member's sheet of a day, or of several days:
 * `covers` the whole month before last or last month, or this month from its 1st to the day before
 * the seed day, with its quantities for a whole month counted for those days; none on a month's 1st)
 * or One sale
 * (`single`), finalized unless `draft`. `channel`: a channel the business adds (its key) or a starter
 * channel by its kind; default: its first starter channel. Lines: a product's key, the quantity and the
 * price (default its usual price). Delivery: the area, what the customer was charged and what it cost
 * (missing: filled later, D-230). One sale may name its customer (M3 Step 5) and be paid later, then
 * paid on the days of `payments`.
 */
export interface DemoSale {
  readonly key: string
  readonly daysAgo: DemoDay
  readonly source: 'day_sheet' | 'single'
  readonly covers?: 'month_before' | 'last_month' | 'this_month'
  readonly channel?: string
  readonly branch?: string
  /** The member who enters (and finalizes) it; default: the owner. */
  readonly enteredBy?: string
  readonly draft?: true
  readonly delivery?: { readonly area: string; readonly charged: string; readonly cost?: string }
  readonly lines: readonly (readonly [product: string, qty: string, price?: string])[]
  readonly customer?: string
  /** "They'll pay later" (Q17): owed by its customer until paid. */
  readonly payLater?: true
  readonly payments?: readonly DemoCustomerPayment[]
}

/** A customer (M3 Step 5): a person, a company or a government body. */
export interface DemoCustomer {
  readonly key: string
  readonly name: string
  readonly kind?: CustomerKind
  readonly phone?: string
  readonly email?: string
  /** 15 digits (a VAT-registered company's). */
  readonly trn?: string
  /** A company's or government body's trade licence. */
  readonly tradeLicenceNo?: string
  readonly emirate?: Emirate
}

/**
 * An order (M3 Step 5): entered on its day, due `dueIn` days after, for a customer (with their LPO
 * number, `customerRef`), with a deposit paid with it; delivered on its day (a sale of that day, its
 * cost frozen then) or cancelled; then paid, and refunded (by amount or quantity of one product's
 * line, the money given back with it). Entered and delivered by `enteredBy` (default: the owner).
 */
export interface DemoOrder {
  readonly key: string
  readonly daysAgo: DemoDay
  readonly dueIn?: number
  readonly customer: string
  readonly customerRef?: string
  readonly enteredBy?: string
  /** Delivered by the business: the area, what the customer was charged (if anything), its cost. */
  readonly delivery?: { readonly area: string; readonly charged?: string; readonly cost?: string }
  readonly lines: readonly (readonly [product: string, qty: string, price?: string])[]
  readonly deposit?: { readonly method: SettlementMethod; readonly amount: string }
  readonly deliveredDaysAgo?: DemoDay
  readonly cancelledDaysAgo?: DemoDay
  readonly payments?: readonly DemoCustomerPayment[]
  readonly refund?: {
    readonly key: string
    readonly daysAgo: DemoDay
    readonly by: CreditBy
    readonly product: string
    /** The quantity (by quantity) or the amount (by amount) taken off. */
    readonly value: string
    readonly notes?: string
    /** The money given back with it, in full. */
    readonly payBack?: SettlementMethod
  }
}

/**
 * How a sales file is laid out (M3 Step 4), as the POS or app exports it, one row per day and item:
 * - `pos`: a POS's sales by item, in English: Business Date, Item, Qty, Net Sales, VAT, Total (a
 *   column before VAT: no VAT question), with a Tips row on the days tips were taken;
 * - `delivery_app`: a delivery app's items report, in Arabic: the order date, the item, the quantity
 *   and the amount the customers paid (with VAT: "Do these amounts include VAT?" Yes);
 * - `marketplace`: a marketplace's sales report, in English: Order Date, SKU, Product Title,
 *   Quantity, Sales and the Commission it kept (a fee column: the channel's statement for the file's
 *   days);
 * - `pos_codes`: a shop POS's item sales with barcodes, in English: Date, Barcode, Description, Qty,
 *   Amount (with VAT).
 */
export type DemoFileLayout = 'pos' | 'delivery_app' | 'marketplace' | 'pos_codes'

/** An item as a sales file names it. */
export interface DemoFileItem {
  /** The product it is. */
  readonly product: string
  /** As the file names it (default: the product's own name, which matches it). */
  readonly name?: string
  /** Its item code (barcode or SKU), for a layout with codes. */
  readonly code?: string
  /** Its price in the file (default: the product's usual price), with VAT when the file's has it. */
  readonly price?: string
  /** About how many are sold a day (more at the weekend; the days vary around it). */
  readonly perDay: number
}

/**
 * A sales file imported (M3 Step 4): last month's (its every day) or this month's so far (its 1st to
 * the day before the seed day; none on a month's 1st), for one channel and branch, imported the day
 * after its last day by `enteredBy` (default: the owner). The names it gives that match no product are
 * answered once, as the owner would on the import's page (by item code when the file has codes); the
 * answers are remembered, so later files match them.
 */
export interface DemoImport {
  readonly key: string
  /** The file's name as exported, before its days ("pos-sales-by-item" → "…-2026-09-01-2026-09-30.csv"). */
  readonly file: string
  readonly month: 'last' | 'this'
  readonly channel: string
  readonly branch?: string
  readonly enteredBy?: string
  readonly layout: DemoFileLayout
  readonly items: readonly DemoFileItem[]
  /** A fee column (`marketplace`): what the app kept of each row, in % of its amount. */
  readonly feePercent?: string
  /** A Tips row of about this much on one day in two (`pos`), answered "not something I sell". */
  readonly tips?: string
}

/**
 * A channel's statement for days of last month (M3 Step 4, D-257), typed from the app's statement and
 * finalized: the sales it lists are what its imported files of those days add up to; the app kept a
 * commission and payment fees (a % of them) and ads.
 */
export interface DemoStatement {
  readonly key: string
  readonly channel: string
  /** Its first and last day of last month (a day past the month's end: its last day). */
  readonly days: readonly [from: number, to: number]
  readonly commissionPercent: string
  readonly paymentFeesPercent?: string
  readonly ads?: string
  readonly notes?: string
}

export interface DemoCosting {
  readonly suppliers?: readonly DemoSupplier[]
  readonly materials?: readonly DemoMaterial[]
  readonly products?: readonly DemoProduct[]
  readonly recipes?: readonly DemoRecipe[]
  readonly purchases?: readonly DemoPurchase[]
  readonly returns?: readonly DemoReturn[]
  readonly payments?: readonly DemoPayment[]
  readonly runningCosts?: readonly DemoRunningCost[]
  readonly expenses?: readonly DemoExpense[]
  /** A business without a team: the owner's hourly rate (D-119). */
  readonly ownerHourlyRate?: string
  /** Channels it adds (M3 Step 2). */
  readonly channels?: readonly DemoChannel[]
  /** Its sales, entered after the purchases of their days (M3 Step 2). */
  readonly sales?: readonly DemoSale[]
  /** Its sales files (M3 Step 4). */
  readonly imports?: readonly DemoImport[]
  /** Its channels' statements (M3 Step 4). */
  readonly statements?: readonly DemoStatement[]
  /** Its customers (M3 Step 5). */
  readonly customers?: readonly DemoCustomer[]
  /** Its orders, with deposits, payments and refunds (M3 Step 5). */
  readonly orders?: readonly DemoOrder[]
}

const pack = (key: string, name: string, qty: string, of: UnitOrPack): DemoPack => ({
  key,
  name,
  qty,
  of,
})

// ---------------------------------------------------------------------------------------------------
// مقهى ركن البن (coffee shop, VAT-registered, a team, two branches)
// ---------------------------------------------------------------------------------------------------

export const CAFE_COSTING: DemoCosting = {
  suppliers: [
    { key: 'roaster', name: 'محمصة البن الذهبي', phone: '+971 4 555 0142', trn: '100987654300003' },
    {
      key: 'dairy',
      name: 'شركة الواحة للأغذية الطازجة',
      phone: '+971 4 555 0178',
      trn: '100876543200003',
    },
    {
      key: 'packaging',
      name: 'مؤسسة التغليف الحديث',
      phone: '+971 6 555 0190',
      trn: '100765432100003',
    },
  ],
  materials: [
    {
      key: 'beans',
      name: 'حبوب قهوة إسبريسو',
      unit: 'kg',
      packs: [pack('bag', 'كيس 1 كغ', '1', 'kg')],
    },
    {
      key: 'milk',
      name: 'حليب طازج',
      unit: 'l',
      packs: [
        pack('bottle', 'علبة 1 لتر', '1', 'l'),
        pack('carton', 'كرتون 12 علبة', '12', 'bottle'),
      ],
    },
    {
      key: 'condensed',
      name: 'حليب مكثف محلى',
      unit: 'l',
      packs: [
        pack('can', 'علبة 300 مل', '300', 'ml'),
        pack('carton', 'كرتون 24 علبة', '24', 'can'),
      ],
    },
    {
      key: 'vanilla',
      name: 'شراب الفانيلا',
      unit: 'l',
      packs: [pack('bottle', 'زجاجة 750 مل', '750', 'ml')],
    },
    {
      key: 'caramel',
      name: 'شراب الكراميل',
      unit: 'l',
      packs: [pack('bottle', 'زجاجة 750 مل', '750', 'ml')],
    },
    {
      key: 'cups',
      name: 'أكواب 12 أونصة',
      unit: 'piece',
      packs: [pack('box', 'علبة 50 كوب', '50', 'piece')],
    },
    {
      key: 'lids',
      name: 'أغطية الأكواب',
      unit: 'piece',
      packs: [pack('box', 'علبة 100 غطاء', '100', 'piece')],
    },
    {
      key: 'straws',
      name: 'مصاصات',
      unit: 'piece',
      packs: [pack('box', 'علبة 250 مصاصة', '250', 'piece')],
    },
  ],
  products: [
    { key: 'spanish', name: 'سبانش لاتيه', unit: 'piece', price: '18', priceIncludesVat: true },
    { key: 'americano', name: 'أمريكانو', unit: 'piece', price: '13', priceIncludesVat: true },
    { key: 'cappuccino', name: 'كابتشينو', unit: 'piece', price: '16', priceIncludesVat: true },
    { key: 'iced', name: 'آيس لاتيه', unit: 'piece', price: '18', priceIncludesVat: true },
    {
      key: 'macchiato',
      name: 'كراميل ماكياتو',
      unit: 'piece',
      price: '20',
      priceIncludesVat: true,
    },
    {
      key: 'croissant',
      name: 'كرواسون',
      unit: 'piece',
      price: '13',
      priceIncludesVat: true,
      resale: { key: 'croissant', packs: [pack('box', 'علبة 12 حبة', '12', 'piece')] },
    },
  ],
  recipes: [
    // The owner's Spanish Latte (PRODUCT.md): exactly these quantities.
    {
      product: 'spanish',
      lines: [
        ['beans', '18', 'g'],
        ['milk', '200', 'ml'],
        ['condensed', '25', 'ml'],
        ['cups', '1', 'piece'],
        ['lids', '1', 'piece'],
        ['straws', '1', 'piece'],
      ],
    },
    {
      product: 'americano',
      lines: [
        ['beans', '18', 'g'],
        ['cups', '1', 'piece'],
        ['lids', '1', 'piece'],
      ],
    },
    {
      product: 'cappuccino',
      lines: [
        ['beans', '18', 'g'],
        ['milk', '150', 'ml'],
        ['cups', '1', 'piece'],
        ['lids', '1', 'piece'],
      ],
    },
    {
      product: 'iced',
      lines: [
        ['beans', '18', 'g'],
        ['milk', '220', 'ml'],
        ['cups', '1', 'piece'],
        ['lids', '1', 'piece'],
        ['straws', '1', 'piece'],
      ],
    },
    {
      product: 'macchiato',
      lines: [
        ['beans', '18', 'g'],
        ['milk', '200', 'ml'],
        ['vanilla', '15', 'ml'],
        ['caramel', '15', 'ml'],
        ['cups', '1', 'piece'],
        ['lids', '1', 'piece'],
      ],
    },
  ],
  purchases: [
    {
      key: 'r1',
      daysAgo: 125,
      supplier: 'roaster',
      payment: 'supplier_credit',
      reference: 'GB-0412',
      lines: [
        ['beans', '80', 'bag', '75'],
        ['vanilla', '4', 'bottle', '32'],
        ['caramel', '4', 'bottle', '32'],
      ],
    },
    {
      key: 'd1',
      daysAgo: 123,
      supplier: 'dairy',
      payment: 'card',
      reference: 'WF-58812',
      lines: [
        ['milk', '50', 'carton', '54'],
        ['condensed', '3', 'carton', '96'],
        ['croissant', '40', 'box', '30'],
      ],
    },
    {
      key: 'k1',
      daysAgo: 121,
      supplier: 'packaging',
      payment: 'bank_transfer',
      reference: 'MP-1187',
      lines: [
        ['cups', '150', 'box', '18'],
        ['lids', '80', 'box', '14'],
        ['straws', '16', 'box', '9'],
      ],
    },
    {
      key: 'd2',
      daysAgo: 110,
      supplier: 'dairy',
      payment: 'card',
      reference: 'WF-59240',
      lines: [
        ['milk', '50', 'carton', '54.5'],
        ['condensed', '2', 'carton', '96'],
        ['croissant', '40', 'box', '30.5'],
      ],
    },
    {
      key: 'r2',
      daysAgo: 96,
      supplier: 'roaster',
      payment: 'supplier_credit',
      reference: 'GB-0468',
      lines: [
        ['beans', '80', 'bag', '76'],
        ['vanilla', '3', 'bottle', '32.5'],
        ['caramel', '4', 'bottle', '32.5'],
      ],
    },
    {
      key: 'd3',
      daysAgo: 92,
      supplier: 'dairy',
      payment: 'card',
      reference: 'WF-59731',
      lines: [
        ['milk', '55', 'carton', '55'],
        ['condensed', '3', 'carton', '97'],
        ['croissant', '45', 'box', '31'],
      ],
    },
    {
      key: 'k2',
      daysAgo: 80,
      supplier: 'packaging',
      payment: 'bank_transfer',
      reference: 'MP-1236',
      lines: [
        ['cups', '150', 'box', '18.5'],
        ['lids', '80', 'box', '14.5'],
        ['straws', '16', 'box', '9'],
      ],
    },
    {
      key: 'd4',
      daysAgo: 75,
      supplier: 'dairy',
      payment: 'card',
      reference: 'WF-60215',
      lines: [
        ['milk', '55', 'carton', '56'],
        ['condensed', '3', 'carton', '98'],
        ['croissant', '45', 'box', '31.5'],
      ],
    },
    {
      key: 'r3',
      daysAgo: 66,
      supplier: 'roaster',
      payment: 'supplier_credit',
      reference: 'GB-0521',
      lines: [
        ['beans', '85', 'bag', '78'],
        ['vanilla', '4', 'bottle', '33'],
        ['caramel', '4', 'bottle', '33'],
      ],
    },
    // Condensed milk from a supermarket for the Mirdif branch: no supplier, a receipt, cash.
    {
      key: 'm1',
      daysAgo: 62,
      document: 'non_tax_invoice',
      payment: 'cash',
      branch: 'فرع مردف',
      lines: [['condensed', '8', 'can', '8.5']],
    },
    {
      key: 'd5',
      daysAgo: 50,
      supplier: 'dairy',
      payment: 'card',
      reference: 'WF-61102',
      lines: [
        ['milk', '55', 'carton', '57'],
        ['condensed', '3', 'carton', '99'],
        ['croissant', '45', 'box', '32'],
      ],
    },
    {
      key: 'r4',
      daysAgo: 35,
      supplier: 'roaster',
      payment: 'supplier_credit',
      reference: 'GB-0577',
      lines: [
        ['beans', '85', 'bag', '80'],
        ['vanilla', '4', 'bottle', '34'],
        ['caramel', '4', 'bottle', '34'],
      ],
    },
    {
      key: 'k3',
      daysAgo: 32,
      supplier: 'packaging',
      payment: 'bank_transfer',
      reference: 'MP-1301',
      lines: [
        ['cups', '160', 'box', '19'],
        ['lids', '85', 'box', '15'],
        ['straws', '18', 'box', '9.5'],
      ],
    },
    {
      key: 'd6',
      daysAgo: 20,
      supplier: 'dairy',
      payment: 'card',
      reference: 'WF-61877',
      lines: [
        ['milk', '60', 'carton', '57.5'],
        ['condensed', '3', 'carton', '100'],
        ['croissant', '45', 'box', '32.5'],
      ],
    },
    {
      key: 'r5',
      daysAgo: 5,
      supplier: 'roaster',
      payment: 'supplier_credit',
      reference: 'GB-0634',
      lines: [
        ['beans', '85', 'bag', '81'],
        ['vanilla', '4', 'bottle', '34.5'],
        ['caramel', '4', 'bottle', '34.5'],
      ],
    },
    {
      key: 'd7',
      daysAgo: 3,
      supplier: 'dairy',
      payment: 'card',
      reference: 'WF-62390',
      lines: [
        ['milk', '60', 'carton', '58'],
        ['condensed', '3', 'carton', '100'],
        ['croissant', '45', 'box', '33'],
      ],
    },
  ],
  returns: [
    {
      key: 'd3-return',
      purchase: 'd3',
      daysAgo: 90,
      kind: 'return',
      reference: 'RN-0091',
      notes: 'كرتونان تالفان عند الاستلام',
      lines: [['milk', '2']],
    },
    {
      key: 'r3-credit',
      purchase: 'r3',
      daysAgo: 60,
      kind: 'credit_note',
      reference: 'CN-0107',
      notes: 'خصم على سعر البن بعد مراجعة الجودة',
      lines: [['beans', '170']],
    },
  ],
  payments: [
    {
      key: 'r1-paid',
      purchase: 'r1',
      daysAgo: 100,
      method: 'bank_transfer',
      amount: 'outstanding',
    },
    { key: 'r2-paid', purchase: 'r2', daysAgo: 70, method: 'bank_transfer', amount: 'outstanding' },
    { key: 'r3-paid', purchase: 'r3', daysAgo: 40, method: 'bank_transfer', amount: 'outstanding' },
    { key: 'r4-part', purchase: 'r4', daysAgo: 10, method: 'bank_transfer', amount: '4000' },
    // The barista is paid back part of what she spent.
    {
      key: 'ice-part',
      expense: 'ice',
      daysAgo: 8,
      method: 'cash',
      amount: '40',
      note: 'دفعة أولى',
    },
  ],
  runningCosts: [
    // Both shops' rent and staff, the Mirdif branch's included (Release A: it sells every day now).
    // Business-wide, as running costs are spread over every branch's sales (Q6 A): a cost named
    // after one branch would make that branch look the most profitable.
    { key: 'rent', name: 'إيجار المحلين', category: 'rent', amount: '19500' },
    { key: 'electricity', name: 'الكهرباء', category: 'electricity', amount: '2400' },
    { key: 'water', name: 'الماء', category: 'water', amount: '450' },
    { key: 'salaries', name: 'رواتب الموظفين', category: 'salaries', amount: '25000' },
    { key: 'internet', name: 'الإنترنت', category: 'internet', amount: '399' },
    { key: 'pos', name: 'اشتراك نظام نقاط البيع', category: 'software', amount: '299' },
    {
      key: 'licence',
      name: 'الرخصة التجارية',
      category: 'licences',
      amount: '15000',
      frequency: 'yearly',
    },
  ],
  expenses: [
    {
      key: 'ads',
      daysAgo: 70,
      category: 'marketing',
      description: 'طباعة المنيو',
      amount: '180',
      payment: 'cash',
      reference: 'PR-2231',
    },
    {
      key: 'instagram',
      daysAgo: 45,
      category: 'marketing',
      description: 'إعلان ممول على إنستغرام',
      amount: '500',
      document: 'non_tax_invoice',
      payment: 'card',
    },
    {
      key: 'machine',
      daysAgo: 40,
      category: 'maintenance',
      description: 'صيانة ماكينة الإسبريسو',
      amount: '650',
      supplier: 'roaster',
      payment: 'supplier_credit',
      reference: 'GB-S-0093',
    },
    {
      key: 'cleaning',
      daysAgo: 25,
      category: 'other',
      description: 'مواد تنظيف',
      amount: '85',
      document: 'non_tax_invoice',
      payment: 'cash',
    },
    // Last month's electricity, billed on the seed day: it is for the month before (the category's
    // bills come the month after, D-194), and replaces the regular 2 400 of the electricity in that
    // month (D-202, D-216: the bill of that running cost).
    {
      key: 'electricity-bill',
      daysAgo: 0,
      category: 'electricity',
      pays: { runningCost: 'electricity' },
      description: 'فاتورة الكهرباء للشهر الماضي',
      amount: '2610',
      payment: 'bank_transfer',
      reference: 'DEWA-118734',
    },
    // The owner's own example (D-216): a bonus for last month under Salaries, paid on the seed day.
    // It is an extra: last month's salaries are the regular amounts and the bonus on top.
    {
      key: 'bonus',
      daysAgo: 0,
      monthsBack: 1,
      category: 'salaries',
      pays: 'extra',
      description: 'مكافأة الموظفين للشهر الماضي',
      amount: '300',
      document: 'no_invoice',
      payment: 'bank_transfer',
    },
    // The barista bought ice with her own money and entered it herself (D-180).
    {
      key: 'ice',
      daysAgo: 15,
      category: 'other',
      description: 'أكياس ثلج من السوبرماركت',
      amount: '60',
      document: 'no_invoice',
      payment: 'paid_by_member',
      paidBy: 'cafe.barista@demo.bizcost.local',
      enteredBy: 'cafe.barista@demo.bizcost.local',
    },
    // With approval on (D-164): the barista sends her expenses; the manager approved one, which the
    // owner then finalized, and the last one waits for approval.
    {
      key: 'napkins',
      daysAgo: 6,
      category: 'other',
      description: 'مناديل ورقية للطاولات',
      amount: '45',
      document: 'non_tax_invoice',
      payment: 'cash',
      enteredBy: 'cafe.barista@demo.bizcost.local',
      approval: { by: 'cafe.manager@demo.bizcost.local' },
    },
    {
      key: 'mint',
      daysAgo: 1,
      category: 'other',
      description: 'نعناع وليمون للمشروبات الباردة',
      amount: '38',
      document: 'no_invoice',
      payment: 'paid_by_member',
      paidBy: 'cafe.barista@demo.bizcost.local',
      enteredBy: 'cafe.barista@demo.bizcost.local',
      approval: 'waiting',
    },
  ],
  channels: [{ key: 'talabat', name: 'طلبات', kind: 'delivery_app', feePercent: '20' }],
  // Release A (M3 Step 4): each branch's POS file and Talabat's items report, imported for last month
  // and for this month so far (the main branch's by the owner, Mirdif's by the manager). The POS names
  // its items in English: the owner answered them once (and its tips "not something I sell"), and the
  // later files matched those answers; Talabat's names are the menu's. About AED 82 000 a month before
  // VAT, against running costs of about AED 51 000.
  imports: [
    ...(['last', 'this'] as const).flatMap((month): DemoImport[] => [
      {
        key: `pos-main-${month}`,
        file: 'pos-sales-by-item-main',
        month,
        channel: 'shop',
        layout: 'pos',
        tips: '45',
        items: [
          { product: 'spanish', name: 'Spanish Latte', perDay: 34 },
          { product: 'americano', name: 'Americano', perDay: 16 },
          { product: 'cappuccino', name: 'Cappuccino', perDay: 20 },
          { product: 'iced', name: 'Iced Latte', perDay: 14 },
          { product: 'macchiato', name: 'Caramel Macchiato', perDay: 9 },
          { product: 'croissant', name: 'Butter Croissant', perDay: 18 },
        ],
      },
      {
        key: `pos-mirdif-${month}`,
        file: 'pos-sales-by-item-mirdif',
        month,
        channel: 'shop',
        branch: 'فرع مردف',
        enteredBy: 'cafe.manager@demo.bizcost.local',
        layout: 'pos',
        items: [
          { product: 'spanish', name: 'Spanish Latte', perDay: 14 },
          { product: 'americano', name: 'Americano', perDay: 7 },
          { product: 'cappuccino', name: 'Cappuccino', perDay: 8 },
          { product: 'iced', name: 'Iced Latte', perDay: 6 },
          { product: 'croissant', name: 'Butter Croissant', perDay: 6 },
        ],
      },
      {
        key: `talabat-${month}`,
        file: 'talabat-items-report',
        month,
        channel: 'talabat',
        layout: 'delivery_app',
        // Talabat's prices are higher than the shop's.
        items: [
          { product: 'spanish', price: '21', perDay: 6 },
          { product: 'macchiato', price: '23', perDay: 4 },
          { product: 'iced', price: '21', perDay: 3 },
          { product: 'croissant', price: '15', perDay: 3 },
        ],
      },
    ]),
  ],
  // Talabat's two statements of last month (its fees replace the 20 % for those days, D-257); this
  // month's sales keep the 20 % until its statement comes.
  statements: [
    {
      key: 'talabat-first-half',
      channel: 'talabat',
      days: [1, 15],
      commissionPercent: '17',
      paymentFeesPercent: '2.5',
      ads: '150',
      notes: 'كشف طلبات للنصف الأول من الشهر',
    },
    {
      key: 'talabat-second-half',
      channel: 'talabat',
      days: [16, 31],
      commissionPercent: '17',
      paymentFeesPercent: '2.5',
      notes: 'كشف طلبات للنصف الثاني من الشهر',
    },
  ],
  sales: [
    // The month before last, before the POS files: each branch's month and Talabat's, typed in.
    {
      key: 'month-before-main',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      channel: 'shop',
      lines: [
        ['spanish', '1000'],
        ['americano', '470'],
        ['cappuccino', '590'],
        ['iced', '410'],
        ['macchiato', '260'],
        ['croissant', '530'],
      ],
    },
    {
      key: 'month-before-mirdif',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      channel: 'shop',
      branch: 'فرع مردف',
      lines: [
        ['spanish', '400'],
        ['americano', '200'],
        ['cappuccino', '230'],
        ['iced', '170'],
        ['croissant', '170'],
      ],
    },
    {
      key: 'month-before-talabat',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      channel: 'talabat',
      lines: [
        ['spanish', '170', '21'],
        ['macchiato', '115', '23'],
        ['iced', '85', '21'],
        ['croissant', '85', '15'],
      ],
    },
    // Today, before the POS file: the barista's sheet, not finalized yet.
    {
      key: 'barista-today',
      daysAgo: 0,
      source: 'day_sheet',
      channel: 'shop',
      enteredBy: 'cafe.barista@demo.bizcost.local',
      draft: true,
      lines: [['spanish', '7']],
    },
  ],
}

// ---------------------------------------------------------------------------------------------------
// حلويات سارة المنزلية (home baker, alone, not VAT-registered)
// ---------------------------------------------------------------------------------------------------

export const BAKER_COSTING: DemoCosting = {
  suppliers: [{ key: 'boxes', name: 'مخازن مستلزمات الحلويات', phone: '+971 50 555 0133' }],
  materials: [
    { key: 'flour', name: 'طحين أبيض', unit: 'kg', packs: [pack('bag', 'كيس 10 كغ', '10', 'kg')] },
    { key: 'sugar', name: 'سكر ناعم', unit: 'kg', packs: [pack('bag', 'كيس 5 كغ', '5', 'kg')] },
    { key: 'butter', name: 'زبدة', unit: 'kg', packs: [pack('block', 'قالب 500 غ', '500', 'g')] },
    {
      key: 'eggs',
      name: 'بيض',
      unit: 'piece',
      packs: [pack('tray', 'طبق 30 بيضة', '30', 'piece')],
    },
    { key: 'cream', name: 'كريمة خفق', unit: 'l', packs: [pack('carton', 'علبة 1 لتر', '1', 'l')] },
    { key: 'cocoa', name: 'كاكاو بودرة', unit: 'kg', packs: [pack('bag', 'كيس 1 كغ', '1', 'kg')] },
    {
      key: 'cakeBox',
      name: 'علب الكيك',
      unit: 'piece',
      packs: [pack('bundle', 'رزمة 10 علب', '10', 'piece')],
    },
    {
      key: 'cupcakeBox',
      name: 'علب كب كيك 6 حبات',
      unit: 'piece',
      packs: [pack('bundle', 'رزمة 10 علب', '10', 'piece')],
    },
    {
      key: 'liners',
      name: 'كاسات كب كيك ورقية',
      unit: 'piece',
      packs: [pack('box', 'علبة 100 كاسة', '100', 'piece')],
    },
  ],
  products: [
    // One cake makes 12 slices (D-178): sold by the slice and whole.
    { key: 'slice', name: 'كيكة شوكولاتة (قطعة)', unit: 'piece', price: '15', ownerMinutes: '7.5' },
    { key: 'cake', name: 'كيكة شوكولاتة كاملة', unit: 'piece', price: '160', ownerMinutes: '90' },
    {
      key: 'cupcakes',
      name: 'كب كيك (علبة 6 حبات)',
      unit: 'piece',
      price: '45',
      ownerMinutes: '25',
    },
  ],
  recipes: [
    {
      product: 'slice',
      makes: '12',
      lines: [
        ['flour', '300', 'g'],
        ['sugar', '250', 'g'],
        ['butter', '200', 'g'],
        ['eggs', '4', 'piece'],
        ['cocoa', '80', 'g'],
        ['cream', '250', 'ml'],
      ],
    },
    {
      product: 'cake',
      lines: [
        ['flour', '300', 'g'],
        ['sugar', '250', 'g'],
        ['butter', '200', 'g'],
        ['eggs', '4', 'piece'],
        ['cocoa', '80', 'g'],
        ['cream', '250', 'ml'],
        ['cakeBox', '1', 'piece'],
      ],
    },
    {
      product: 'cupcakes',
      makes: '2',
      lines: [
        ['flour', '250', 'g'],
        ['sugar', '200', 'g'],
        ['butter', '150', 'g'],
        ['eggs', '3', 'piece'],
        ['cocoa', '40', 'g'],
        ['cream', '200', 'ml'],
        ['liners', '12', 'piece'],
        ['cupcakeBox', '2', 'piece'],
      ],
    },
  ],
  purchases: [
    {
      key: 'b1',
      daysAgo: 124,
      payment: 'cash',
      lines: [
        ['flour', '2', 'bag', '32'],
        ['sugar', '2', 'bag', '18'],
        ['butter', '8', 'block', '14'],
        ['eggs', '4', 'tray', '22'],
        ['cream', '6', 'carton', '16'],
        ['cocoa', '2', 'bag', '45'],
      ],
    },
    {
      key: 'b2',
      daysAgo: 118,
      supplier: 'boxes',
      payment: 'cash',
      lines: [
        ['cakeBox', '3', 'bundle', '25'],
        ['cupcakeBox', '3', 'bundle', '20'],
        ['liners', '3', 'box', '8'],
      ],
    },
    {
      key: 'b3',
      daysAgo: 108,
      payment: 'cash',
      lines: [
        ['butter', '8', 'block', '14.5'],
        ['eggs', '4', 'tray', '22'],
        ['cream', '6', 'carton', '16.5'],
        ['sugar', '2', 'bag', '18'],
      ],
    },
    {
      key: 'b4',
      daysAgo: 95,
      payment: 'cash',
      lines: [
        ['flour', '2', 'bag', '33'],
        ['butter', '8', 'block', '15'],
        ['eggs', '4', 'tray', '23'],
        ['cream', '8', 'carton', '16.5'],
        ['cocoa', '2', 'bag', '47'],
      ],
    },
    {
      key: 'b5',
      daysAgo: 80,
      payment: 'card',
      lines: [
        ['butter', '8', 'block', '15'],
        ['eggs', '4', 'tray', '23'],
        ['cream', '6', 'carton', '17'],
        ['sugar', '2', 'bag', '19'],
      ],
    },
    {
      key: 'b6',
      daysAgo: 66,
      payment: 'cash',
      lines: [
        ['flour', '2', 'bag', '34'],
        ['eggs', '4', 'tray', '24'],
        ['cream', '8', 'carton', '17'],
        ['cocoa', '2', 'bag', '49'],
        ['butter', '10', 'block', '15.5'],
      ],
    },
    {
      key: 'b7',
      daysAgo: 60,
      supplier: 'boxes',
      payment: 'cash',
      lines: [
        ['cakeBox', '3', 'bundle', '26'],
        ['cupcakeBox', '3', 'bundle', '21'],
        ['liners', '2', 'box', '8.5'],
      ],
    },
    {
      key: 'b8',
      daysAgo: 50,
      payment: 'cash',
      lines: [
        ['butter', '8', 'block', '16'],
        ['eggs', '4', 'tray', '24'],
        ['cream', '6', 'carton', '17.5'],
        ['sugar', '2', 'bag', '19.5'],
      ],
    },
    {
      key: 'b9',
      daysAgo: 36,
      payment: 'card',
      lines: [
        ['flour', '2', 'bag', '35'],
        ['butter', '8', 'block', '16'],
        ['eggs', '4', 'tray', '25'],
        ['cream', '8', 'carton', '18'],
        ['cocoa', '2', 'bag', '52'],
      ],
    },
    {
      key: 'b10',
      daysAgo: 21,
      payment: 'cash',
      lines: [
        ['butter', '8', 'block', '16'],
        ['eggs', '4', 'tray', '25'],
        ['cream', '6', 'carton', '18'],
        ['sugar', '2', 'bag', '20'],
      ],
    },
    {
      key: 'b11',
      daysAgo: 7,
      payment: 'cash',
      lines: [
        ['flour', '2', 'bag', '35'],
        ['eggs', '4', 'tray', '25'],
        ['butter', '8', 'block', '16.5'],
        ['cocoa', '2', 'bag', '52'],
        ['cream', '6', 'carton', '18'],
      ],
    },
  ],
  runningCosts: [
    { key: 'gas', name: 'أسطوانات غاز الطبخ', category: { name: 'الغاز' }, amount: '120' },
    { key: 'electricity', name: 'حصة المطبخ من الكهرباء', category: 'electricity', amount: '250' },
    { key: 'delivery', name: 'اشتراك تطبيق التوصيل', category: 'software', amount: '150' },
  ],
  expenses: [
    {
      key: 'tools',
      daysAgo: 45,
      category: 'equipment',
      description: 'قوالب وأدوات تزيين',
      amount: '145',
      payment: 'cash',
    },
    {
      key: 'ads',
      daysAgo: 30,
      category: 'marketing',
      description: 'إعلان على إنستغرام',
      amount: '100',
      payment: 'card',
    },
  ],
  ownerHourlyRate: '45',
  // The month before last, typed in at once (one sale on its last day covering it from its 1st, Q9:
  // real profit counts the month's costs from that 1st, D-250). Last month: whole cakes ordered on
  // WhatsApp (the orders below), and what she sold to neighbours and her regulars typed in at once.
  // This month so far: the same, typed for its days, and One sale delivered yesterday.
  sales: [
    {
      key: 'month-before',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      lines: [
        ['slice', '70'],
        ['cupcakes', '16'],
        ['cake', '7'],
      ],
    },
    {
      key: 'last-month',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'last_month',
      lines: [
        ['slice', '64'],
        ['cupcakes', '14'],
        ['cake', '3'],
      ],
    },
    {
      key: 'this-month',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'this_month',
      lines: [
        ['slice', '60'],
        ['cupcakes', '12'],
      ],
    },
    {
      key: 'cupcakes-delivery',
      daysAgo: 1,
      source: 'single',
      delivery: { area: 'الجميرا', charged: '15', cost: '12' },
      lines: [['cupcakes', '2']],
    },
  ],
  // M3 Step 5: orders taken on WhatsApp with a deposit, delivered by a courier she pays; last month's
  // paid in full on delivery. This month: one delivered, paid and partly refunded (the cake arrived a
  // little damaged), one waiting, one cancelled and its deposit given back.
  customers: [
    { key: 'fatima', name: 'فاطمة المنصوري', phone: '050 123 4567', emirate: 'dubai' },
    { key: 'mariam', name: 'مريم الشامسي', phone: '055 765 4321' },
    {
      key: 'events',
      name: 'لمسات للمناسبات',
      kind: 'business',
      phone: '04 333 2211',
      tradeLicenceNo: '1029384',
      emirate: 'dubai',
    },
    { key: 'noura', name: 'نورة الكتبي', phone: '050 448 2190', emirate: 'dubai' },
    { key: 'hessa', name: 'حصة السويدي', phone: '052 310 7745', emirate: 'dubai' },
    { key: 'aisha', name: 'عائشة المري', phone: '056 902 3381', emirate: 'sharjah' },
  ],
  orders: [
    {
      key: 'sep-noura',
      daysAgo: lastMonth(4, -3),
      dueIn: 3,
      customer: 'noura',
      delivery: { area: 'دبي هيلز', charged: '20', cost: '22' },
      lines: [['cake', '1', '160']],
      deposit: { method: 'bank_transfer', amount: '80' },
      deliveredDaysAgo: lastMonth(4),
      payments: [{ key: 'rest', daysAgo: lastMonth(4), method: 'cash', amount: 'outstanding' }],
    },
    {
      key: 'sep-hessa',
      daysAgo: lastMonth(11, -4),
      dueIn: 4,
      customer: 'hessa',
      delivery: { area: 'مردف', charged: '20', cost: '25' },
      lines: [
        ['cake', '1'],
        ['cupcakes', '1'],
      ],
      deposit: { method: 'bank_transfer', amount: '100' },
      deliveredDaysAgo: lastMonth(11),
      payments: [{ key: 'rest', daysAgo: lastMonth(11), method: 'card', amount: 'outstanding' }],
    },
    {
      key: 'sep-events',
      daysAgo: lastMonth(18, -6),
      dueIn: 6,
      customer: 'events',
      customerRef: 'PO-2240',
      delivery: { area: 'الصفوح', charged: '30', cost: '35' },
      lines: [
        ['cupcakes', '6'],
        ['cake', '2', '150'],
      ],
      deposit: { method: 'card', amount: '250' },
      deliveredDaysAgo: lastMonth(18),
      payments: [
        { key: 'rest', daysAgo: lastMonth(25), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-aisha',
      daysAgo: lastMonth(25, -2),
      dueIn: 2,
      customer: 'aisha',
      delivery: { area: 'الشارقة - المجاز', charged: '25', cost: '30' },
      lines: [['cake', '1', '160']],
      deposit: { method: 'cash', amount: '50' },
      deliveredDaysAgo: lastMonth(25),
      payments: [{ key: 'rest', daysAgo: lastMonth(25), method: 'cash', amount: 'outstanding' }],
    },
    {
      key: 'birthday',
      daysAgo: 6,
      dueIn: 3,
      customer: 'fatima',
      delivery: { area: 'البرشاء', charged: '20', cost: '25' },
      lines: [['cake', '1', '150']],
      deposit: { method: 'bank_transfer', amount: '50' },
      deliveredDaysAgo: 3,
      payments: [{ key: 'rest', daysAgo: 3, method: 'cash', amount: '120' }],
      refund: {
        key: 'damaged',
        daysAgo: 2,
        by: 'amount',
        product: 'cake',
        value: '20',
        notes: 'وصلت الكيكة متضررة قليلًا',
        payBack: 'cash',
      },
    },
    {
      key: 'party',
      daysAgo: 2,
      dueIn: 4,
      customer: 'events',
      customerRef: 'PO-2291',
      lines: [
        ['cupcakes', '4'],
        ['cake', '1'],
      ],
      deposit: { method: 'card', amount: '100' },
    },
    {
      key: 'cancelled',
      daysAgo: 5,
      dueIn: 2,
      customer: 'mariam',
      lines: [['cake', '1']],
      deposit: { method: 'cash', amount: '40' },
      cancelledDaysAgo: 4,
      payments: [{ key: 'deposit-back', daysAgo: 4, method: 'cash', amount: '40', kind: 'refund' }],
    },
  ],
}

// ---------------------------------------------------------------------------------------------------
// Layer Lab 3D (3D printing maker, one helper, not VAT-registered; the owner works in English)
// ---------------------------------------------------------------------------------------------------

export const PRINT3D_COSTING: DemoCosting = {
  suppliers: [
    { key: 'maker', name: 'Maker Supplies Trading', phone: '+971 4 555 0111' },
    { key: 'resin', name: 'Resin Works Trading', phone: '+971 4 555 0164' },
  ],
  materials: [
    {
      key: 'pla',
      name: 'PLA filament',
      unit: 'kg',
      packs: [pack('spool', 'Spool 1 kg', '1', 'kg')],
    },
    {
      key: 'petg',
      name: 'PETG filament',
      unit: 'kg',
      packs: [pack('spool', 'Spool 1 kg', '1', 'kg')],
    },
    // Bought by the litre, used by the gram: 1 L of resin weighs 1.1 kg.
    {
      key: 'resin',
      name: 'Standard resin',
      unit: 'kg',
      cross: [{ unit: 'l', qty: '1.1', ofUnit: 'kg' }],
      packs: [pack('bottle', 'Bottle 1 L', '1', 'l')],
    },
    {
      key: 'bags',
      name: 'Packaging bags',
      unit: 'piece',
      packs: [pack('pack', 'Pack of 100', '100', 'piece')],
    },
  ],
  products: [
    { key: 'holder', name: 'Phone holder', unit: 'piece', price: '35' },
    { key: 'organizer', name: 'Desk cable organizer', unit: 'piece', price: '45' },
    { key: 'part', name: 'Custom part', unit: 'piece', price: '90' },
    { key: 'prototype', name: 'Prototype', unit: 'piece', price: '250' },
  ],
  recipes: [
    {
      product: 'holder',
      lines: [
        ['pla', '45', 'g'],
        ['bags', '1', 'piece'],
      ],
    },
    {
      product: 'organizer',
      lines: [
        ['pla', '80', 'g'],
        ['bags', '1', 'piece'],
      ],
    },
    {
      product: 'part',
      lines: [
        ['petg', '120', 'g'],
        ['bags', '1', 'piece'],
      ],
    },
    {
      product: 'prototype',
      lines: [
        ['resin', '150', 'g'],
        ['pla', '60', 'g'],
        ['bags', '1', 'piece'],
      ],
    },
  ],
  purchases: [
    {
      key: 'l1',
      daysAgo: 124,
      supplier: 'maker',
      payment: 'card',
      reference: 'MS-3301',
      lines: [
        ['pla', '8', 'spool', '75'],
        ['petg', '3', 'spool', '85'],
        ['bags', '2', 'pack', '25'],
      ],
    },
    {
      key: 'l2',
      daysAgo: 105,
      supplier: 'resin',
      payment: 'card',
      reference: 'RW-0871',
      lines: [['resin', '2', 'bottle', '120']],
    },
    {
      key: 'l3',
      daysAgo: 90,
      supplier: 'maker',
      payment: 'card',
      reference: 'MS-3388',
      lines: [
        ['pla', '8', 'spool', '76'],
        ['petg', '3', 'spool', '86'],
      ],
    },
    {
      key: 'l4',
      daysAgo: 75,
      supplier: 'maker',
      payment: 'card',
      reference: 'MS-3452',
      lines: [
        ['pla', '10', 'spool', '78'],
        ['petg', '4', 'spool', '88'],
        ['bags', '2', 'pack', '25'],
      ],
    },
    {
      key: 'l5',
      daysAgo: 60,
      supplier: 'resin',
      payment: 'card',
      reference: 'RW-0934',
      lines: [['resin', '3', 'bottle', '125']],
    },
    {
      key: 'l6',
      daysAgo: 45,
      supplier: 'maker',
      payment: 'card',
      reference: 'MS-3519',
      lines: [
        ['pla', '10', 'spool', '79'],
        ['petg', '4', 'spool', '90'],
      ],
    },
    {
      key: 'l7',
      daysAgo: 30,
      supplier: 'maker',
      payment: 'card',
      reference: 'MS-3577',
      lines: [
        ['pla', '8', 'spool', '74'],
        ['bags', '2', 'pack', '26'],
      ],
    },
    {
      key: 'l8',
      daysAgo: 15,
      supplier: 'resin',
      payment: 'card',
      reference: 'RW-1002',
      lines: [['resin', '2', 'bottle', '128']],
    },
    {
      key: 'l9',
      daysAgo: 6,
      supplier: 'maker',
      payment: 'card',
      reference: 'MS-3640',
      lines: [
        ['pla', '6', 'spool', '77'],
        ['petg', '3', 'spool', '90'],
      ],
    },
  ],
  runningCosts: [
    {
      key: 'electricity',
      name: 'Electricity for the printers',
      category: 'electricity',
      amount: '350',
    },
    { key: 'maintenance', name: 'Printer maintenance', category: 'maintenance', amount: '150' },
    { key: 'software', name: 'Slicer and CAD software', category: 'software', amount: '220' },
    { key: 'helper', name: "Helper's salary (part-time)", category: 'salaries', amount: '2000' },
    {
      key: 'printers',
      name: 'Printers (spread over 2 years)',
      category: 'equipment',
      amount: '400',
    },
  ],
  expenses: [
    {
      key: 'ipa',
      daysAgo: 50,
      category: 'other',
      description: 'Isopropyl alcohol 5 L for resin prints',
      amount: '95',
      payment: 'card',
    },
    {
      key: 'nozzles',
      daysAgo: 20,
      // Spare parts on top of the printers' monthly share (a bill of 'printers' would take its place).
      category: 'equipment',
      pays: 'extra',
      description: 'Replacement nozzles',
      amount: '60',
      payment: 'card',
    },
    // The website's payment gateway charged its fees for last month: marked as the website's app
    // fees (M3 Step 3, Q8), so they sit on its sales, never with the running costs.
    {
      key: 'gateway',
      daysAgo: 0,
      monthsBack: 1,
      category: 'other',
      pays: { channelFees: 'website' },
      description: 'Payment gateway fees, last month',
      amount: '24',
      payment: 'card',
    },
  ],
  channels: [{ key: 'noon', name: 'noon', kind: 'marketplace' }],
  // noon's sales report with its Commission column (M3 Step 4): each file's fees become noon's
  // statement for its days. The SKUs are answered once, and this month's file matches them.
  imports: (['last', 'this'] as const).map((month): DemoImport => ({
    key: `noon-${month}`,
    file: 'noon-sales-report',
    month,
    channel: 'noon',
    layout: 'marketplace',
    feePercent: '15',
    items: [
      { product: 'holder', code: 'LL-PH-01', name: 'Adjustable phone holder, black', perDay: 2.2 },
      { product: 'organizer', code: 'LL-CO-02', name: 'Desk cable organizer set', perDay: 1.2 },
    ],
  })),
  // The month before last typed in at once, before noon and the orders; the website's sales one by
  // one, and a part the helper sold.
  sales: [
    {
      key: 'month-before',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      channel: 'messages',
      lines: [
        ['holder', '55'],
        ['organizer', '25'],
        ['part', '10'],
        ['prototype', '4'],
      ],
    },
    {
      key: 'sep-website-holders',
      daysAgo: lastMonth(6),
      source: 'single',
      channel: 'website',
      lines: [['holder', '4']],
    },
    {
      key: 'sep-website-desk',
      daysAgo: lastMonth(19),
      source: 'single',
      channel: 'website',
      lines: [
        ['organizer', '3'],
        ['holder', '2'],
      ],
    },
    {
      key: 'holders',
      daysAgo: 4,
      source: 'single',
      channel: 'website',
      lines: [['holder', '6']],
    },
    {
      key: 'helper-part',
      daysAgo: 2,
      source: 'single',
      // A custom part is ordered on WhatsApp, never on noon.
      channel: 'messages',
      enteredBy: 'print3d.helper@demo.bizcost.local',
      lines: [['part', '2', '95']],
    },
  ],
  // M3 Step 5: custom parts and prototypes ordered on WhatsApp, half paid when ordered; one this
  // month entered and delivered by the helper, and one waiting.
  customers: [
    {
      key: 'studio',
      name: 'Bright Ideas Studio',
      kind: 'business',
      phone: '04 555 0198',
      tradeLicenceNo: '884120',
      emirate: 'dubai',
    },
    { key: 'khalid', name: 'Khalid Rahman', phone: '050 771 2045', emirate: 'dubai' },
    {
      key: 'robotics',
      name: 'Gulf Tech Robotics Club',
      kind: 'business',
      phone: '06 555 0122',
      tradeLicenceNo: '730551',
      emirate: 'sharjah',
    },
  ],
  orders: [
    {
      key: 'sep-studio',
      daysAgo: lastMonth(3),
      dueIn: 6,
      customer: 'studio',
      lines: [['prototype', '3']],
      deposit: { method: 'bank_transfer', amount: '375' },
      deliveredDaysAgo: lastMonth(9),
      payments: [
        { key: 'rest', daysAgo: lastMonth(10), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-khalid',
      daysAgo: lastMonth(12),
      dueIn: 4,
      customer: 'khalid',
      lines: [['part', '6']],
      deposit: { method: 'cash', amount: '270' },
      deliveredDaysAgo: lastMonth(16),
      payments: [{ key: 'rest', daysAgo: lastMonth(16), method: 'cash', amount: 'outstanding' }],
    },
    {
      key: 'sep-robotics',
      daysAgo: lastMonth(20),
      dueIn: 7,
      customer: 'robotics',
      customerRef: 'PO-GTR-0912',
      lines: [
        ['part', '10', '85'],
        ['prototype', '1'],
      ],
      deposit: { method: 'card', amount: '500' },
      deliveredDaysAgo: lastMonth(27),
      payments: [
        { key: 'rest', daysAgo: lastMonth(29), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'helper-parts',
      daysAgo: 9,
      dueIn: 5,
      customer: 'khalid',
      enteredBy: 'print3d.helper@demo.bizcost.local',
      lines: [['part', '4']],
      deliveredDaysAgo: 3,
      payments: [{ key: 'paid', daysAgo: 2, method: 'cash', amount: 'outstanding' }],
    },
    {
      key: 'studio-prototypes',
      daysAgo: 5,
      dueIn: 7,
      customer: 'studio',
      lines: [['prototype', '2']],
      deposit: { method: 'bank_transfer', amount: '250' },
    },
  ],
}

// ---------------------------------------------------------------------------------------------------
// بقالة الخير (grocery, VAT-registered): goods bought ready to sell, in cartons, sold by the piece
// ---------------------------------------------------------------------------------------------------

const carton = (count: string, what: string) => [
  pack('carton', `كرتون ${count} ${what}`, count, 'piece'),
]

export const GROCERY_COSTING: DemoCosting = {
  suppliers: [
    {
      key: 'drinks',
      name: 'مؤسسة الينابيع لتوزيع المياه والعصائر',
      phone: '+971 6 555 0120',
      trn: '100654321000003',
    },
    {
      key: 'food',
      name: 'شركة الخليج لتوزيع المواد الغذائية',
      phone: '+971 6 555 0155',
      trn: '100543210900003',
    },
  ],
  products: (
    [
      ['water', 'مياه شرب 500 مل', '1', '24', 'عبوة'],
      ['juice', 'عصير برتقال 1 لتر', '8', '12', 'عبوة'],
      ['milk', 'حليب طويل الأجل 1 لتر', '6.5', '12', 'عبوة'],
      ['rice', 'أرز بسمتي 5 كغ', '48', '4', 'أكياس'],
      ['oil', 'زيت دوار الشمس 1.8 لتر', '23.5', '6', 'عبوات'],
      ['sugar', 'سكر أبيض 2 كغ', '9.5', '10', 'أكياس'],
      ['tea', 'شاي أسود 100 كيس', '13', '24', 'علبة'],
      ['tissues', 'مناديل ورقية 200 منديل', '4', '30', 'علبة'],
    ] as const
  ).map(([key, name, price, count, what]): DemoProduct => ({
    key,
    name,
    unit: 'piece',
    price,
    priceIncludesVat: true,
    resale: { key, packs: carton(count, what) },
  })),
  purchases: [
    ...(
      [
        [124, '11.5', '60', '52'],
        [104, '11.5', '60.5', '52'],
        [84, '11.75', '61', '52.5'],
        [64, '11.75', '62', '53'],
        [44, '12', '62', '53.5'],
        [24, '12', '63', '54'],
        [6, '12', '63', '54'],
      ] as const
    ).map(([daysAgo, water, juice, milk], i): DemoPurchase => ({
      key: `w${i + 1}`,
      daysAgo,
      supplier: 'drinks',
      payment: 'bank_transfer',
      reference: `YN-${7410 + i * 37}`,
      lines: [
        ['water', '375', 'carton', water],
        ['juice', '135', 'carton', juice],
        ['milk', '180', 'carton', milk],
      ],
    })),
    ...(
      [
        [122, '130', '96', '62', '190', '66'],
        [97, '131', '98', '62', '192', '66'],
        [72, '133', '99', '63', '194', '67'],
        [47, '134', '101', '64', '196', '68'],
        [22, '136', '102', '65', '198', '69'],
      ] as const
    ).map(([daysAgo, rice, oil, sugar, tea, tissues], i): DemoPurchase => ({
      key: `f${i + 1}`,
      daysAgo,
      supplier: 'food',
      payment: 'supplier_credit',
      reference: `KG-${20510 + i * 113}`,
      lines: [
        ['rice', '75', 'carton', rice],
        ['oil', '90', 'carton', oil],
        ['sugar', '60', 'carton', sugar],
        ['tea', '40', 'carton', tea],
        ['tissues', '60', 'carton', tissues],
      ],
    })),
  ],
  payments: [
    { key: 'f1-paid', purchase: 'f1', daysAgo: 95, method: 'bank_transfer', amount: 'outstanding' },
    { key: 'f2-paid', purchase: 'f2', daysAgo: 70, method: 'bank_transfer', amount: 'outstanding' },
    { key: 'f3-paid', purchase: 'f3', daysAgo: 45, method: 'bank_transfer', amount: 'outstanding' },
    { key: 'f4-part', purchase: 'f4', daysAgo: 15, method: 'cheque', amount: '10000' },
  ],
  runningCosts: [
    { key: 'rent', name: 'إيجار المحل', category: 'rent', amount: '6500' },
    { key: 'electricity', name: 'الكهرباء', category: 'electricity', amount: '1600' },
    { key: 'cashier', name: 'راتب الكاشير', category: 'salaries', amount: '3500' },
  ],
  expenses: [
    {
      key: 'bags',
      daysAgo: 40,
      category: 'other',
      description: 'أكياس تسوق',
      amount: '180',
      payment: 'cash',
    },
    {
      key: 'fridge',
      daysAgo: 25,
      category: 'maintenance',
      description: 'صيانة ثلاجة العرض',
      amount: '350',
      payment: 'cash',
    },
  ],
  // The POS file of the counter (M3 Step 4): items by barcode, with VAT. Last month's barcodes were
  // answered once (the POS names its items in English); this month's file matched them by code.
  imports: (['last', 'this'] as const).map((month): DemoImport => ({
    key: `pos-${month}`,
    file: 'pos-item-sales',
    month,
    channel: 'shop',
    layout: 'pos_codes',
    items: [
      { product: 'water', code: '6290000100017', name: 'DRINKING WATER 500ML', perDay: 170 },
      { product: 'juice', code: '6290000100024', name: 'ORANGE JUICE 1L', perDay: 36 },
      { product: 'milk', code: '6290000100031', name: 'UHT MILK FULL CREAM 1L', perDay: 52 },
      { product: 'rice', code: '6290000100048', name: 'BASMATI RICE 5KG', perDay: 9 },
      { product: 'oil', code: '6290000100055', name: 'SUNFLOWER OIL 1.8L', perDay: 10 },
      { product: 'sugar', code: '6290000100062', name: 'WHITE SUGAR 2KG', perDay: 16 },
      { product: 'tea', code: '6290000100079', name: 'BLACK TEA 100 BAGS', perDay: 12 },
      { product: 'tissues', code: '6290000100086', name: 'FACIAL TISSUES 200', perDay: 30 },
    ],
  })),
  // The month before last, before the POS file: the counter's month typed in at once. Orders on
  // WhatsApp, delivered to the neighbourhood: the cashier types them in Today's sales (last month's at
  // once, then each day).
  sales: [
    {
      key: 'month-before',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      channel: 'shop',
      lines: [
        ['water', '5200'],
        ['juice', '1080'],
        ['milk', '1560'],
        ['rice', '270'],
        ['oil', '300'],
        ['sugar', '470'],
        ['tea', '350'],
        ['tissues', '880'],
      ],
    },
    {
      key: 'whatsapp-last-month',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'last_month',
      channel: 'messages',
      enteredBy: 'retail.cashier@demo.bizcost.local',
      lines: [
        ['water', '480'],
        ['rice', '22'],
        ['oil', '26'],
        ['milk', '120'],
        ['sugar', '30'],
      ],
    },
    ...([2, 1] as const).map((daysAgo): DemoSale => ({
      key: `whatsapp-${daysAgo}`,
      daysAgo,
      source: 'day_sheet',
      channel: 'messages',
      enteredBy: 'retail.cashier@demo.bizcost.local',
      lines: [
        ['water', String(12 + daysAgo * 6)],
        ['juice', String(2 + daysAgo)],
        ['milk', String(4 + daysAgo)],
        ['rice', String(1 + daysAgo)],
      ],
    })),
  ],
}

// ---------------------------------------------------------------------------------------------------
// نجارة الإتقان (carpentry workshop, VAT-registered, a team)
// ---------------------------------------------------------------------------------------------------

export const WORKSHOP_COSTING: DemoCosting = {
  suppliers: [
    {
      key: 'wood',
      name: 'مستودع النخيل للأخشاب',
      phone: '+971 6 555 0102',
      trn: '100432109800003',
    },
    {
      key: 'fittings',
      name: 'مؤسسة الفجر لمستلزمات النجارة',
      phone: '+971 6 555 0147',
      trn: '100321098700003',
    },
  ],
  materials: [
    {
      key: 'mdf',
      name: 'ألواح MDF 18 مم',
      unit: 'm2',
      packs: [pack('sheet', 'لوح 1.22×2.44 م', '2.9768', 'm2')],
    },
    { key: 'beech', name: 'خشب زان', unit: 'm', packs: [pack('plank', 'لوح 3 م', '3', 'm')] },
    {
      key: 'screws',
      name: 'براغي خشب 4×40 مم',
      unit: 'piece',
      packs: [pack('box', 'علبة 200 برغي', '200', 'piece')],
    },
    { key: 'varnish', name: 'ورنيش شفاف', unit: 'l', packs: [pack('can', 'علبة 4 لتر', '4', 'l')] },
    {
      key: 'hinges',
      name: 'مفصلات خزائن',
      unit: 'piece',
      packs: [pack('box', 'علبة 10 مفصلات', '10', 'piece')],
    },
  ],
  products: [
    { key: 'table', name: 'طاولة طعام حسب الطلب', unit: 'piece', price: '2400' },
    { key: 'cabinet', name: 'خزانة ملابس بابين', unit: 'piece', price: '4200' },
    { key: 'bookcase', name: 'مكتبة حائط', unit: 'piece', price: '3200' },
  ],
  recipes: [
    {
      product: 'table',
      lines: [
        ['mdf', '2', 'm2'],
        ['beech', '8', 'm'],
        ['screws', '40', 'piece'],
        ['varnish', '1', 'l'],
      ],
    },
    {
      product: 'cabinet',
      lines: [
        ['mdf', '9', 'm2'],
        ['beech', '12', 'm'],
        ['screws', '120', 'piece'],
        ['varnish', '2', 'l'],
        ['hinges', '6', 'piece'],
      ],
    },
    {
      product: 'bookcase',
      lines: [
        ['mdf', '6', 'm2'],
        ['beech', '6', 'm'],
        ['screws', '80', 'piece'],
        ['varnish', '1.5', 'l'],
        ['hinges', '4', 'piece'],
      ],
    },
  ],
  purchases: [
    ...(
      [
        [124, 'bank_transfer', '95', '45'],
        [100, 'bank_transfer', '96', '45'],
        [76, 'bank_transfer', '98', '46'],
        [55, 'supplier_credit', '100', '47'],
        [30, 'supplier_credit', '102', '48'],
        [3, 'supplier_credit', '103', '48'],
      ] as const
    ).map(([daysAgo, payment, mdf, beech], i): DemoPurchase => ({
      key: `wood${i + 1}`,
      daysAgo,
      supplier: 'wood',
      payment,
      reference: `NK-${3120 + i * 41}`,
      lines: [
        ['mdf', '40', 'sheet', mdf],
        ['beech', '50', 'plank', beech],
      ],
    })),
    ...(
      [
        [118, '28', '120', '35'],
        [85, '28', '122', '35'],
        [48, '29', '126', '36'],
        [12, '29', '128', '36'],
      ] as const
    ).map(([daysAgo, screws, varnish, hinges], i): DemoPurchase => ({
      key: `fit${i + 1}`,
      daysAgo,
      supplier: 'fittings',
      payment: 'card',
      reference: `FJ-${880 + i * 29}`,
      lines: [
        ['screws', '5', 'box', screws],
        ['varnish', '4', 'can', varnish],
        ['hinges', '6', 'box', hinges],
      ],
    })),
  ],
  payments: [
    {
      key: 'wood4-paid',
      purchase: 'wood4',
      daysAgo: 25,
      method: 'bank_transfer',
      amount: 'outstanding',
    },
  ],
  runningCosts: [
    { key: 'rent', name: 'إيجار الورشة', category: 'rent', amount: '8000' },
    { key: 'electricity', name: 'الكهرباء', category: 'electricity', amount: '1800' },
    { key: 'salaries', name: 'رواتب النجارين', category: 'salaries', amount: '14000' },
    { key: 'machines', name: 'صيانة الماكينات', category: 'maintenance', amount: '500' },
  ],
  expenses: (
    [
      [100, '220'],
      [70, '240'],
      [40, '235'],
      [10, '250'],
    ] as const
  ).map(([daysAgo, amount], i): DemoExpense => ({
    key: `fuel${i + 1}`,
    daysAgo,
    category: 'vehicles',
    description: 'وقود الفان',
    amount,
    payment: 'card',
  })),
  // The month before last typed in at once, before its orders; a table sold this month without one.
  sales: [
    {
      key: 'month-before',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      lines: [
        ['cabinet', '5'],
        ['table', '3'],
        ['bookcase', '2'],
      ],
    },
    { key: 'table', daysAgo: 3, source: 'single', lines: [['table', '1', '2350']] },
  ],
  // M3 Step 5: orders with a deposit (about half, by cheque, transfer or cash), the rest paid on
  // delivery or soon after; last month's five, and this month a developer's LPO for two wardrobes
  // (delivered, paid in part), a bookcase the supervisor took (delivered, paid) and a family's table
  // with a cheque deposit, waiting.
  customers: [
    {
      key: 'developer',
      name: 'مجموعة الريم العقارية',
      kind: 'business',
      phone: '02 555 0101',
      email: 'procurement@alreem.example',
      trn: '100456789000003',
      tradeLicenceNo: 'CN-2234567',
      emirate: 'abu_dhabi',
    },
    { key: 'hamdan', name: 'حمدان الكعبي', phone: '050 999 1212', emirate: 'sharjah' },
    { key: 'villa', name: 'عبدالرحمن الملا', phone: '050 662 1408', emirate: 'sharjah' },
    {
      key: 'clinic',
      name: 'عيادة الشفاء الطبية',
      kind: 'business',
      phone: '06 556 2290',
      trn: '100789012300003',
      tradeLicenceNo: '613280',
      emirate: 'sharjah',
    },
    {
      key: 'school',
      name: 'مدرسة النور الخاصة',
      kind: 'business',
      phone: '06 548 1100',
      tradeLicenceNo: '402917',
      emirate: 'ajman',
    },
    { key: 'apartment', name: 'سارة الطنيجي', phone: '055 218 7730', emirate: 'sharjah' },
  ],
  orders: [
    {
      key: 'sep-villa-wardrobes',
      daysAgo: lastMonth(1, -9),
      dueIn: 12,
      customer: 'villa',
      lines: [['cabinet', '2']],
      deposit: { method: 'cheque', amount: '4410' },
      deliveredDaysAgo: lastMonth(5),
      payments: [
        { key: 'rest', daysAgo: lastMonth(6), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-clinic',
      daysAgo: lastMonth(3),
      dueIn: 11,
      customer: 'clinic',
      customerRef: 'LPO-CLN-118',
      lines: [
        ['table', '1'],
        ['cabinet', '1'],
      ],
      deposit: { method: 'cash', amount: '2770' },
      deliveredDaysAgo: lastMonth(14),
      payments: [{ key: 'rest', daysAgo: lastMonth(14), method: 'card', amount: 'outstanding' }],
    },
    {
      key: 'sep-school-bookcases',
      daysAgo: lastMonth(8),
      dueIn: 12,
      customer: 'school',
      customerRef: 'LPO-NS-2026-14',
      lines: [['bookcase', '2']],
      deposit: { method: 'bank_transfer', amount: '3360' },
      deliveredDaysAgo: lastMonth(20),
      payments: [
        { key: 'rest', daysAgo: lastMonth(24), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-apartment',
      daysAgo: lastMonth(10),
      dueIn: 12,
      customer: 'apartment',
      lines: [['cabinet', '2', '4100']],
      deposit: { method: 'bank_transfer', amount: '4305' },
      deliveredDaysAgo: lastMonth(22),
      payments: [{ key: 'rest', daysAgo: lastMonth(22), method: 'card', amount: 'outstanding' }],
    },
    {
      key: 'sep-hamdan-tables',
      daysAgo: lastMonth(15),
      dueIn: 12,
      customer: 'hamdan',
      lines: [['table', '2']],
      deposit: { method: 'cash', amount: '1000' },
      deliveredDaysAgo: lastMonth(27),
    },
    {
      key: 'wardrobes',
      daysAgo: 12,
      dueIn: 10,
      customer: 'developer',
      customerRef: 'LPO-4471',
      lines: [['cabinet', '2', '4100']],
      deliveredDaysAgo: 2,
      payments: [{ key: 'first', daysAgo: 1, method: 'bank_transfer', amount: '5000' }],
    },
    {
      key: 'villa-bookcase',
      daysAgo: 9,
      dueIn: 5,
      customer: 'villa',
      enteredBy: 'workshop.supervisor@demo.bizcost.local',
      lines: [
        ['bookcase', '1'],
        ['table', '1'],
      ],
      deliveredDaysAgo: 4,
      payments: [{ key: 'paid', daysAgo: 4, method: 'cheque', amount: 'outstanding' }],
    },
    {
      key: 'table',
      daysAgo: 4,
      dueIn: 14,
      customer: 'hamdan',
      lines: [['table', '1', '2400']],
      deposit: { method: 'cheque', amount: '1260' },
    },
    // M3 Step 8: the clinic's kitchen unit against its LPO, half paid by transfer when ordered and
    // delivered yesterday: its deposit tax invoice, then its final invoice (demo/invoices.ts).
    {
      key: 'clinic-kitchen',
      daysAgo: 9,
      dueIn: 8,
      customer: 'clinic',
      customerRef: 'LPO-CLN-131',
      lines: [['cabinet', '1']],
      deposit: { method: 'bank_transfer', amount: '2205' },
      deliveredDaysAgo: 1,
    },
  ],
}

// ---------------------------------------------------------------------------------------------------
// مصنع النقاء لمواد التنظيف (small factory, VAT-registered, a team)
// ---------------------------------------------------------------------------------------------------

export const FACTORY_COSTING: DemoCosting = {
  suppliers: [
    {
      key: 'chemicals',
      name: 'شركة الخليج للكيماويات الصناعية',
      phone: '+971 6 555 0171',
      trn: '100210987600003',
    },
    {
      key: 'plastics',
      name: 'مصنع العبوات البلاستيكية الحديث',
      phone: '+971 6 555 0138',
      trn: '100109876500003',
    },
    {
      key: 'print',
      name: 'مطبعة النور للملصقات',
      phone: '+971 6 555 0126',
      trn: '100098765400003',
    },
  ],
  materials: [
    {
      key: 'sles',
      name: 'مادة SLES المنظفة',
      unit: 'kg',
      packs: [pack('drum', 'برميل 170 كغ', '170', 'kg')],
    },
    { key: 'salt', name: 'ملح صناعي', unit: 'kg', packs: [pack('bag', 'كيس 50 كغ', '50', 'kg')] },
    {
      key: 'citric',
      name: 'حمض الستريك',
      unit: 'kg',
      packs: [pack('bag', 'كيس 25 كغ', '25', 'kg')],
    },
    {
      key: 'fragrance',
      name: 'عطر الليمون المركز',
      unit: 'l',
      packs: [pack('jerrycan', 'جركن 5 لتر', '5', 'l')],
    },
    {
      key: 'bottles',
      name: 'عبوات بلاستيك 1 لتر',
      unit: 'piece',
      packs: [pack('carton', 'كرتون 200 عبوة', '200', 'piece')],
    },
    {
      key: 'caps',
      name: 'أغطية العبوات',
      unit: 'piece',
      packs: [pack('bag', 'كيس 1000 غطاء', '1000', 'piece')],
    },
    {
      key: 'labels',
      name: 'ملصقات منظف الأرضيات',
      unit: 'piece',
      packs: [pack('roll', 'لفة 1000 ملصق', '1000', 'piece')],
    },
    {
      key: 'jerrycans',
      name: 'جالون بلاستيك 4 لتر',
      unit: 'piece',
      packs: [pack('carton', 'كرتون 50 جالون', '50', 'piece')],
    },
  ],
  products: [
    { key: 'floor', name: 'منظف أرضيات 1 لتر', unit: 'piece', price: '7.5' },
    { key: 'floor4', name: 'منظف أرضيات 4 لتر', unit: 'piece', price: '24' },
  ],
  recipes: [
    {
      product: 'floor',
      lines: [
        ['sles', '90', 'g'],
        ['salt', '25', 'g'],
        ['citric', '5', 'g'],
        ['fragrance', '8', 'ml'],
        ['bottles', '1', 'piece'],
        ['caps', '1', 'piece'],
        ['labels', '1', 'piece'],
      ],
    },
    {
      product: 'floor4',
      lines: [
        ['sles', '360', 'g'],
        ['salt', '100', 'g'],
        ['citric', '20', 'g'],
        ['fragrance', '32', 'ml'],
        ['jerrycans', '1', 'piece'],
        ['caps', '1', 'piece'],
        ['labels', '1', 'piece'],
      ],
    },
  ],
  purchases: [
    // The 4-litre cans, bought by the carton from the bottles' factory.
    ...(
      [
        [112, '95'],
        [70, '96'],
        [40, '97'],
        [10, '98'],
      ] as const
    ).map(([daysAgo, price], i): DemoPurchase => ({
      key: `pj${i + 1}`,
      daysAgo,
      supplier: 'plastics',
      payment: 'bank_transfer',
      reference: `MPF-J${310 + i * 17}`,
      lines: [['jerrycans', '20', 'carton', price]],
    })),
    {
      key: 'c1',
      daysAgo: 124,
      supplier: 'chemicals',
      payment: 'bank_transfer',
      reference: 'GC-5501',
      lines: [
        ['sles', '5', 'drum', '1020'],
        ['salt', '5', 'bag', '35'],
        ['citric', '2', 'bag', '140'],
        ['fragrance', '15', 'jerrycan', '260'],
      ],
    },
    {
      key: 'p1',
      daysAgo: 121,
      supplier: 'plastics',
      payment: 'supplier_credit',
      reference: 'MPF-2207',
      lines: [
        ['bottles', '50', 'carton', '150'],
        ['caps', '10', 'bag', '120'],
      ],
    },
    {
      key: 'n1',
      daysAgo: 119,
      supplier: 'print',
      payment: 'card',
      reference: 'NP-418',
      lines: [['labels', '10', 'roll', '180']],
    },
    {
      key: 'c2',
      daysAgo: 94,
      supplier: 'chemicals',
      payment: 'bank_transfer',
      reference: 'GC-5588',
      lines: [
        ['sles', '5', 'drum', '1040'],
        ['salt', '5', 'bag', '35'],
        ['fragrance', '16', 'jerrycan', '265'],
      ],
    },
    {
      key: 'p2',
      daysAgo: 90,
      supplier: 'plastics',
      payment: 'supplier_credit',
      reference: 'MPF-2263',
      lines: [
        ['bottles', '50', 'carton', '152'],
        ['caps', '10', 'bag', '120'],
      ],
    },
    {
      key: 'c3',
      daysAgo: 64,
      supplier: 'chemicals',
      payment: 'bank_transfer',
      reference: 'GC-5671',
      lines: [
        ['sles', '6', 'drum', '1060'],
        ['citric', '2', 'bag', '145'],
        ['fragrance', '16', 'jerrycan', '270'],
      ],
    },
    {
      key: 'p3',
      daysAgo: 60,
      supplier: 'plastics',
      payment: 'supplier_credit',
      reference: 'MPF-2318',
      lines: [
        ['bottles', '55', 'carton', '155'],
        ['caps', '11', 'bag', '122'],
      ],
    },
    {
      key: 'n2',
      daysAgo: 58,
      supplier: 'print',
      payment: 'card',
      reference: 'NP-455',
      lines: [['labels', '12', 'roll', '182']],
    },
    {
      key: 'c4',
      daysAgo: 34,
      supplier: 'chemicals',
      payment: 'bank_transfer',
      reference: 'GC-5760',
      lines: [
        ['sles', '6', 'drum', '1080'],
        ['salt', '6', 'bag', '36'],
        ['fragrance', '16', 'jerrycan', '275'],
      ],
    },
    {
      key: 'p4',
      daysAgo: 29,
      supplier: 'plastics',
      payment: 'supplier_credit',
      reference: 'MPF-2371',
      lines: [
        ['bottles', '55', 'carton', '158'],
        ['caps', '11', 'bag', '125'],
      ],
    },
    {
      key: 'c5',
      daysAgo: 8,
      supplier: 'chemicals',
      payment: 'bank_transfer',
      reference: 'GC-5834',
      lines: [
        ['sles', '3', 'drum', '1085'],
        ['citric', '1', 'bag', '150'],
      ],
    },
    {
      key: 'p5',
      daysAgo: 4,
      supplier: 'plastics',
      payment: 'supplier_credit',
      reference: 'MPF-2426',
      lines: [
        ['bottles', '45', 'carton', '160'],
        ['caps', '9', 'bag', '126'],
      ],
    },
    {
      key: 'n3',
      daysAgo: 2,
      supplier: 'print',
      payment: 'card',
      reference: 'NP-497',
      lines: [['labels', '30', 'roll', '185']],
    },
  ],
  payments: [
    { key: 'p1-paid', purchase: 'p1', daysAgo: 95, method: 'bank_transfer', amount: 'outstanding' },
    { key: 'p2-paid', purchase: 'p2', daysAgo: 65, method: 'bank_transfer', amount: 'outstanding' },
    { key: 'p3-paid', purchase: 'p3', daysAgo: 30, method: 'bank_transfer', amount: 'outstanding' },
  ],
  runningCosts: [
    { key: 'rent', name: 'إيجار المصنع', category: 'rent', amount: '10000' },
    { key: 'electricity', name: 'الكهرباء', category: 'electricity', amount: '3500' },
    { key: 'salaries', name: 'رواتب العمال', category: 'salaries', amount: '15000' },
    { key: 'water', name: 'الماء', category: 'water', amount: '600' },
  ],
  expenses: [
    {
      key: 'fuel1',
      daysAgo: 50,
      category: 'vehicles',
      description: 'وقود شاحنة التوصيل',
      amount: '300',
      payment: 'card',
    },
    {
      key: 'fuel2',
      daysAgo: 15,
      category: 'vehicles',
      description: 'وقود شاحنة التوصيل',
      amount: '320',
      payment: 'card',
    },
  ],
  // The month before last typed in at once, before its orders; a trader's 500 bottles this month.
  sales: [
    {
      key: 'month-before',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      lines: [
        ['floor', '6200', '6.8'],
        ['floor4', '780', '22'],
      ],
    },
    { key: 'floor-500', daysAgo: 4, source: 'single', lines: [['floor', '500', '7.25']] },
  ],
  // M3 Step 5: orders on credit against each customer's LPO, entered and delivered by the manager
  // (the factory's truck: its cost typed, charged to the hotel only), paid by transfer or cheque about
  // a month later; the last ones still owed. This month: the hotel's (delivered, paid in part), the
  // supermarket's and the cleaning company's (delivered), and a school's waiting.
  customers: [
    {
      key: 'hotel',
      name: 'فندق اللؤلؤة',
      kind: 'business',
      phone: '04 222 9090',
      email: 'purchasing@lulu-hotel.example',
      trn: '100234567800003',
      tradeLicenceNo: '778899',
      emirate: 'dubai',
    },
    {
      key: 'school',
      name: 'مدرسة الأجيال الخاصة',
      kind: 'business',
      phone: '06 544 7788',
      tradeLicenceNo: '552211',
      emirate: 'sharjah',
    },
    {
      key: 'supermarket',
      name: 'أسواق الوفاء',
      kind: 'business',
      phone: '06 533 4410',
      email: 'buying@alwafa-markets.example',
      trn: '100890123400003',
      tradeLicenceNo: '440912',
      emirate: 'sharjah',
    },
    {
      key: 'cleaning',
      name: 'شركة لمعان لخدمات التنظيف',
      kind: 'business',
      phone: '04 388 1270',
      trn: '100901234500003',
      tradeLicenceNo: '1187356',
      emirate: 'dubai',
    },
  ],
  orders: [
    {
      key: 'sep-cleaning-1',
      daysAgo: lastMonth(2),
      dueIn: 3,
      customer: 'cleaning',
      customerRef: 'LPO-CL-7781',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'القوز', cost: '90' },
      lines: [
        ['floor4', '300', '22'],
        ['floor', '600', '6.8'],
      ],
      deliveredDaysAgo: lastMonth(4),
      payments: [
        { key: 'transfer', daysAgo: lastMonth(30), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-hotel',
      daysAgo: lastMonth(6),
      dueIn: 3,
      customer: 'hotel',
      customerRef: 'LPO-87990',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'جميرا', charged: '150', cost: '120' },
      lines: [
        ['floor4', '120'],
        ['floor', '400', '7'],
      ],
      deliveredDaysAgo: lastMonth(8),
      payments: [
        { key: 'transfer', daysAgo: lastMonth(29), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-supermarket-1',
      daysAgo: lastMonth(10),
      dueIn: 3,
      customer: 'supermarket',
      customerRef: 'PO-55120',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'الشارقة - النهدة', cost: '140' },
      lines: [['floor', '2000', '6.5']],
      deliveredDaysAgo: lastMonth(12),
      payments: [{ key: 'cheque', daysAgo: 6, method: 'cheque', amount: 'outstanding' }],
    },
    {
      key: 'sep-school',
      daysAgo: lastMonth(14),
      dueIn: 3,
      customer: 'school',
      customerRef: 'LPO-2026-027',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'الشارقة - المويلح', cost: '60' },
      lines: [
        ['floor', '500'],
        ['floor4', '40', '25'],
      ],
      deliveredDaysAgo: lastMonth(16),
      payments: [
        { key: 'cheque', daysAgo: lastMonth(26), method: 'cheque', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-cleaning-2',
      daysAgo: lastMonth(19),
      dueIn: 3,
      customer: 'cleaning',
      customerRef: 'LPO-CL-7802',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'القوز', cost: '90' },
      lines: [['floor4', '350', '22']],
      deliveredDaysAgo: lastMonth(21),
    },
    {
      key: 'sep-supermarket-2',
      daysAgo: lastMonth(24),
      dueIn: 3,
      customer: 'supermarket',
      customerRef: 'PO-55208',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'الشارقة - النهدة', cost: '140' },
      lines: [['floor', '1600', '6.5']],
      deliveredDaysAgo: lastMonth(27),
    },
    {
      key: 'cleaning-oct',
      daysAgo: 13,
      dueIn: 3,
      customer: 'cleaning',
      customerRef: 'LPO-CL-7840',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'القوز', cost: '90' },
      lines: [['floor4', '300', '22']],
      deliveredDaysAgo: 11,
    },
    {
      key: 'supermarket-oct',
      daysAgo: 8,
      dueIn: 3,
      customer: 'supermarket',
      customerRef: 'PO-55297',
      enteredBy: 'factory.manager@demo.bizcost.local',
      delivery: { area: 'الشارقة - النهدة', cost: '140' },
      lines: [['floor', '1800', '6.5']],
      deliveredDaysAgo: 6,
    },
    {
      key: 'hotel-lpo',
      daysAgo: 9,
      dueIn: 5,
      customer: 'hotel',
      customerRef: 'LPO-88120',
      delivery: { area: 'جميرا', charged: '150', cost: '120' },
      lines: [['floor', '1200', '7']],
      deliveredDaysAgo: 5,
      payments: [{ key: 'transfer', daysAgo: 2, method: 'bank_transfer', amount: '4000' }],
    },
    {
      key: 'school-lpo',
      daysAgo: 1,
      dueIn: 7,
      customer: 'school',
      customerRef: 'LPO-2026-031',
      lines: [['floor', '300']],
    },
  ],
}

// ---------------------------------------------------------------------------------------------------
// Noura Design Studio (freelance designer, services only, alone, not VAT-registered; English)
// ---------------------------------------------------------------------------------------------------

export const DESIGNER_COSTING: DemoCosting = {
  products: [
    {
      key: 'logo',
      name: 'Logo design',
      type: 'service',
      unit: 'piece',
      price: '1500',
      ownerMinutes: '600',
    },
    {
      key: 'identity',
      name: 'Brand identity package',
      type: 'service',
      unit: 'piece',
      price: '4500',
      ownerMinutes: '1800',
    },
    {
      key: 'social',
      name: 'Social media post design',
      type: 'service',
      unit: 'piece',
      price: '150',
      ownerMinutes: '45',
    },
    {
      key: 'consultation',
      name: 'Design consultation',
      type: 'service',
      unit: 'h',
      price: '250',
      ownerMinutes: '60',
    },
  ],
  runningCosts: [
    { key: 'adobe', name: 'Adobe Creative Cloud', category: 'software', amount: '260' },
    { key: 'laptop', name: 'Laptop (spread over 3 years)', category: 'equipment', amount: '250' },
    { key: 'internet', name: 'Home internet', category: 'internet', amount: '389' },
  ],
  expenses: [
    {
      key: 'photos',
      daysAgo: 80,
      // For a client's work, not the Adobe subscription (a bill of 'software' would take its place).
      category: 'other',
      description: 'Stock photo credits',
      amount: '150',
      payment: 'card',
    },
    {
      key: 'portfolio',
      daysAgo: 55,
      category: 'marketing',
      description: 'Printed portfolio',
      amount: '320',
      payment: 'cash',
    },
    {
      key: 'coworking',
      daysAgo: 30,
      category: 'rent',
      description: 'Co-working day passes',
      amount: '200',
      payment: 'card',
    },
    {
      key: 'font',
      daysAgo: 12,
      category: 'other',
      description: 'Font licence for a client project',
      amount: '180',
      payment: 'card',
    },
  ],
  ownerHourlyRate: '100',
  // One sale per job, for its client (M3 Step 5): small jobs paid on the spot, bigger ones "they'll pay
  // later" and paid by transfer some weeks on; two still owed.
  customers: [
    {
      key: 'brew',
      name: 'Brew & Co. Café',
      kind: 'business',
      phone: '04 555 0177',
      tradeLicenceNo: '991204',
      emirate: 'dubai',
    },
    {
      key: 'spa',
      name: 'Sahara Spa',
      kind: 'business',
      phone: '04 555 0136',
      tradeLicenceNo: '872031',
      emirate: 'dubai',
    },
    {
      key: 'realty',
      name: 'Gulf Realty',
      kind: 'business',
      phone: '02 555 0164',
      tradeLicenceNo: 'CN-3398120',
      emirate: 'abu_dhabi',
    },
    {
      key: 'nursery',
      name: 'Little Steps Nursery',
      kind: 'business',
      phone: '06 555 0149',
      tradeLicenceNo: '610447',
      emirate: 'sharjah',
    },
    { key: 'layla', name: 'Layla Hassan', phone: '050 334 8812', emirate: 'dubai' },
    {
      key: 'bakery',
      name: 'Crumbs Bakery',
      kind: 'business',
      phone: '04 555 0103',
      tradeLicenceNo: '1032877',
      emirate: 'dubai',
    },
  ],
  // The month before last typed in at once; since then one sale per job.
  sales: [
    {
      key: 'month-before',
      daysAgo: 0,
      source: 'day_sheet',
      covers: 'month_before',
      lines: [
        ['logo', '2'],
        ['identity', '1'],
        ['social', '10'],
        ['consultation', '6'],
      ],
    },
    {
      key: 'sep-logo-brew',
      daysAgo: lastMonth(3),
      source: 'single',
      customer: 'brew',
      lines: [['logo', '1']],
    },
    {
      key: 'sep-identity-spa',
      daysAgo: lastMonth(8),
      source: 'single',
      customer: 'spa',
      payLater: true,
      lines: [['identity', '1', '4200']],
      payments: [
        { key: 'paid', daysAgo: lastMonth(25), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-social-realty',
      daysAgo: lastMonth(12),
      source: 'single',
      customer: 'realty',
      payLater: true,
      lines: [['social', '12']],
      payments: [{ key: 'half', daysAgo: lastMonth(28), method: 'bank_transfer', amount: '900' }],
    },
    {
      key: 'sep-consultation-layla',
      daysAgo: lastMonth(19),
      source: 'single',
      customer: 'layla',
      lines: [['consultation', '4']],
    },
    {
      key: 'sep-logo-nursery',
      daysAgo: lastMonth(24),
      source: 'single',
      customer: 'nursery',
      payLater: true,
      lines: [['logo', '1']],
    },
    { key: 'logo', daysAgo: 10, source: 'single', customer: 'bakery', lines: [['logo', '1']] },
    {
      key: 'identity',
      daysAgo: 5,
      source: 'single',
      customer: 'brew',
      payLater: true,
      lines: [['identity', '1', '4200']],
    },
    {
      key: 'consultation',
      daysAgo: 2,
      source: 'single',
      customer: 'layla',
      lines: [['consultation', '3']],
    },
  ],
}

// ---------------------------------------------------------------------------------------------------
// لمسة عصرية للديكور (fit-out / decor projects, VAT-registered, a team)
// ---------------------------------------------------------------------------------------------------

export const FITOUT_COSTING: DemoCosting = {
  suppliers: [
    {
      key: 'paints',
      name: 'مؤسسة الألوان للدهانات',
      phone: '+971 4 555 0185',
      trn: '100987012300003',
    },
    {
      key: 'building',
      name: 'مستودع البناء الحديث',
      phone: '+971 4 555 0119',
      trn: '100876901200003',
    },
  ],
  materials: [
    {
      key: 'paint',
      name: 'دهان داخلي أبيض مطفي',
      unit: 'l',
      packs: [pack('bucket', 'سطل 18 لتر', '18', 'l')],
    },
    {
      key: 'gypsum',
      name: 'ألواح جبس بورد 12.5 مم',
      unit: 'm2',
      packs: [pack('board', 'لوح 1.2×2.4 م', '2.88', 'm2')],
    },
    {
      key: 'adhesive',
      name: 'لاصق بلاط',
      unit: 'kg',
      packs: [pack('bag', 'كيس 20 كغ', '20', 'kg')],
    },
  ],
  // What it sells: work by the square metre and its design and supervision, each a service with no
  // recipe; the materials bought for a job count with that month's costs (Q13 A).
  products: [
    { key: 'gypsum-work', name: 'أعمال جبس بورد', type: 'service', unit: 'm2', price: '95' },
    { key: 'paint-work', name: 'أعمال دهان', type: 'service', unit: 'm2', price: '28' },
    { key: 'tiling', name: 'تركيب بلاط', type: 'service', unit: 'm2', price: '65' },
    { key: 'design', name: 'تصميم وإشراف', type: 'service', unit: 'piece', price: '3500' },
  ],
  purchases: [
    {
      key: 'paint1',
      daysAgo: 124,
      supplier: 'paints',
      payment: 'supplier_credit',
      reference: 'AL-7710',
      lines: [['paint', '20', 'bucket', '210']],
    },
    {
      key: 'build1',
      daysAgo: 115,
      supplier: 'building',
      payment: 'bank_transfer',
      reference: 'BH-4402',
      lines: [
        ['gypsum', '120', 'board', '24'],
        ['adhesive', '40', 'bag', '28'],
      ],
    },
    {
      key: 'paint2',
      daysAgo: 95,
      supplier: 'paints',
      payment: 'supplier_credit',
      reference: 'AL-7788',
      lines: [['paint', '25', 'bucket', '215']],
    },
    {
      key: 'build2',
      daysAgo: 80,
      supplier: 'building',
      payment: 'bank_transfer',
      reference: 'BH-4471',
      lines: [
        ['gypsum', '150', 'board', '25'],
        ['adhesive', '50', 'bag', '28.5'],
      ],
    },
    {
      key: 'paint3',
      daysAgo: 60,
      supplier: 'paints',
      payment: 'supplier_credit',
      reference: 'AL-7853',
      lines: [['paint', '25', 'bucket', '220']],
    },
    // This job's materials of last month (Q13 A: bought for jobs, they count with that month's costs).
    {
      key: 'build3',
      daysAgo: lastMonth(6),
      supplier: 'building',
      payment: 'bank_transfer',
      reference: 'BH-4536',
      lines: [
        ['gypsum', '140', 'board', '26'],
        ['adhesive', '45', 'bag', '29'],
      ],
    },
    {
      key: 'paint4',
      daysAgo: lastMonth(24),
      supplier: 'paints',
      payment: 'supplier_credit',
      reference: 'AL-7921',
      lines: [['paint', '30', 'bucket', '225']],
    },
    {
      key: 'build4',
      daysAgo: 5,
      supplier: 'building',
      payment: 'bank_transfer',
      reference: 'BH-4598',
      lines: [
        ['gypsum', '100', 'board', '26'],
        ['adhesive', '30', 'bag', '30'],
      ],
    },
  ],
  payments: [
    {
      key: 'paint1-paid',
      purchase: 'paint1',
      daysAgo: 90,
      method: 'bank_transfer',
      amount: 'outstanding',
    },
    {
      key: 'paint2-paid',
      purchase: 'paint2',
      daysAgo: 60,
      method: 'bank_transfer',
      amount: 'outstanding',
    },
    { key: 'paint3-part', purchase: 'paint3', daysAgo: 30, method: 'cheque', amount: '3000' },
    // The supervisor is paid back part of what he spent on tools.
    { key: 'tools-part', expense: 'site-tools', daysAgo: 5, method: 'cash', amount: '200' },
  ],
  runningCosts: [
    { key: 'rent', name: 'إيجار المكتب والمستودع', category: 'rent', amount: '9000' },
    { key: 'vehicles', name: 'تأجير سيارتي نقل', category: 'vehicles', amount: '4500' },
    { key: 'salaries', name: 'رواتب الفريق', category: 'salaries', amount: '38000' },
  ],
  expenses: [
    ...(
      [
        [90, '280'],
        [55, '300'],
        [12, '310'],
      ] as const
    ).map(([daysAgo, amount], i): DemoExpense => ({
      key: `fuel${i + 1}`,
      daysAgo,
      // A category of its own: a bill of 'vehicles' would take the van rental's place.
      category: { name: 'الوقود' },
      description: 'وقود سيارات النقل',
      amount,
      payment: 'card',
    })),
    {
      key: 'drill',
      daysAgo: 70,
      category: 'equipment',
      description: 'مثقاب ومعدات يدوية',
      amount: '850',
      payment: 'card',
    },
    {
      key: 'site-tools',
      daysAgo: 18,
      category: 'equipment',
      description: 'عدة يدوية لموقع جميرا',
      amount: '320',
      document: 'no_invoice',
      payment: 'paid_by_member',
      paidBy: 'fitout.supervisor@demo.bizcost.local',
    },
  ],
  // One sale per stage of a job (M3, Step 2), "they'll pay later" (stage invoices come with Release
  // B): the month before last a villa in Mirdif (its last stage, paid since); last month a villa in Al
  // Barsha (ceilings, then painting) and an office in Business Bay (tiling with its design); this
  // month a restaurant's ceilings and painting entered by the supervisor, and the office's next stage.
  customers: [
    { key: 'mirdif', name: 'سعيد بن حارب', phone: '050 274 9930', emirate: 'dubai' },
    { key: 'barsha', name: 'محمد العلي', phone: '050 812 4471', emirate: 'dubai' },
    {
      key: 'office',
      name: 'شركة الأفق للاستشارات',
      kind: 'business',
      phone: '04 431 7720',
      email: 'admin@alofuq-consulting.example',
      trn: '100112233400003',
      tradeLicenceNo: '1209934',
      emirate: 'dubai',
    },
    {
      key: 'restaurant',
      name: 'مطعم السنبوك',
      kind: 'business',
      phone: '04 349 6612',
      trn: '100223344500003',
      tradeLicenceNo: '1173048',
      emirate: 'dubai',
    },
  ],
  sales: [
    {
      key: 'month-before-mirdif-villa',
      daysAgo: lastMonth(1, -28),
      source: 'single',
      customer: 'mirdif',
      payLater: true,
      lines: [
        ['gypsum-work', '360'],
        ['paint-work', '1200'],
        ['design', '1'],
      ],
      payments: [
        { key: 'paid', daysAgo: lastMonth(1, -3), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-barsha-ceilings',
      daysAgo: lastMonth(5),
      source: 'single',
      customer: 'barsha',
      payLater: true,
      lines: [['gypsum-work', '260']],
      payments: [
        { key: 'first', daysAgo: lastMonth(20), method: 'bank_transfer', amount: '12000' },
      ],
    },
    {
      key: 'sep-office-tiling',
      daysAgo: lastMonth(14),
      source: 'single',
      customer: 'office',
      payLater: true,
      lines: [
        ['tiling', '300'],
        ['design', '1'],
      ],
      payments: [
        { key: 'paid', daysAgo: lastMonth(29), method: 'bank_transfer', amount: 'outstanding' },
      ],
    },
    {
      key: 'sep-barsha-painting',
      daysAgo: lastMonth(26),
      source: 'single',
      customer: 'barsha',
      payLater: true,
      lines: [['paint-work', '900']],
    },
    {
      key: 'restaurant-stage-1',
      daysAgo: 8,
      source: 'single',
      customer: 'restaurant',
      payLater: true,
      enteredBy: 'fitout.supervisor@demo.bizcost.local',
      lines: [
        ['gypsum-work', '180'],
        ['paint-work', '400'],
      ],
    },
    {
      key: 'office-stage-2',
      daysAgo: 3,
      source: 'single',
      customer: 'office',
      payLater: true,
      lines: [
        ['paint-work', '300'],
        ['design', '1'],
      ],
    },
  ],
}
