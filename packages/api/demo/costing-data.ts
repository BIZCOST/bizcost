import type {
  PaymentMethod,
  PurchaseDocumentType,
  RunningCostFrequency,
  SettlementMethod,
  StandardUnit,
  StarterCostCategory,
} from '@bizcost/domain'

// The Costing Core data of each demo business (M2: suppliers, materials, products & services,
// recipes, purchases, returns and credit notes, payments, running costs, expenses, the owner's time).
// demo/costing.ts enters it through the API, dated back from the business's today: the first
// purchases are about 4 months old, so the 90-day average (D-115) leaves some out, and each business
// buys again in its last week. Running costs start 8 months back and expenses fall in the last few
// months, so the last full month's costs (D-202) hold both; the café's electricity bill, entered on
// the seed day for the month before, replaces that month's regular electricity. Names are in
// the business's language (one name, D-113). Every amount is a decimal string; prices move a little
// over time, so averages differ from the last price. Keys are stable: they make each record's id, so
// a second run finds what the first one made (a record added later gets a new key; D-185).

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
  readonly daysAgo: number
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
  readonly daysAgo: number
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
  readonly daysAgo: number
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
  readonly daysAgo: number
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
   * The key of the running cost it is the bill of. An expense in a category that has a running cost
   * takes the place of that category's regular amount (D-202, D-203), so only such a bill shares a
   * category with one: an extra goes in a category of its own.
   */
  readonly billOf?: string
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
    { key: 'rent', name: 'إيجار المحل', category: 'rent', amount: '12000' },
    { key: 'electricity', name: 'الكهرباء', category: 'electricity', amount: '2400' },
    { key: 'water', name: 'الماء', category: 'water', amount: '450' },
    { key: 'salaries', name: 'رواتب الموظفين', category: 'salaries', amount: '16000' },
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
    // bills come the month after, D-194), and replaces the regular 2 400 in that month (D-202).
    {
      key: 'electricity-bill',
      daysAgo: 0,
      category: 'electricity',
      billOf: 'electricity',
      description: 'فاتورة الكهرباء للشهر الماضي',
      amount: '2610',
      payment: 'bank_transfer',
      reference: 'DEWA-118734',
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
      // Spare parts, not the maintenance contract (a bill of 'maintenance' would take its place).
      category: 'equipment',
      description: 'Replacement nozzles',
      amount: '60',
      payment: 'card',
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
  ],
  products: [{ key: 'floor', name: 'منظف أرضيات 1 لتر', unit: 'piece', price: '7.5' }],
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
  ],
  purchases: [
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
    {
      key: 'build3',
      daysAgo: 40,
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
      daysAgo: 20,
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
}
