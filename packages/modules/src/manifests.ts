import type { NavEntryDto, QuickActionDto } from '@bizcost/contracts'
import type { SensitivityCategory } from '@bizcost/domain'
import type { CapabilityKey } from './capabilities'

// Module manifests (docs/ARCHITECTURE.md §Modules): the single source for navigation, "+" actions,
// Smart Setup, API guards and Customize BizCost. Every module of PRODUCT.md §7 has one line here.
// A planned module gets its permission keys and nav when its build starts (Products & Services and
// Materials in M2 Step 2, D-124) and stays hidden until it is released: nav, tabs, "+" and the API
// gates count only released modules (the dev-only preview of registry.ts aside, D-125). Modules not
// being built carry no permission keys, nav or actions. M2 Step 7 released the Costing Core
// (Products & Services, Materials, Suppliers, Purchases, Expenses, Running Costs, Files and the Cost
// Engine) together, and Release A (M3 Step 6) Sales, Orders, Customers, Payments and Reports.

export const MODULE_IDS = [
  'dashboard',
  'settings',
  'products',
  'materials',
  'suppliers',
  'purchases',
  'expenses',
  'running_costs',
  'files',
  'cost_engine',
  'sales',
  'orders',
  'customers',
  'payments',
  'reports',
  'quotations',
  'invoices',
  'inventory',
  'usage_waste',
  'employees',
  'attendance',
  'payroll',
  'equipment',
  'vehicles',
  'projects',
  'petty_cash',
  'vat_center',
] as const
export type ModuleId = (typeof MODULE_IDS)[number]

export function isModuleId(value: unknown): value is ModuleId {
  return (MODULE_IDS as readonly unknown[]).includes(value)
}

export type ModuleKind = 'core' | 'optional'
export type ModuleAvailability = 'released' | 'planned'

/**
 * A navigation entry (sidebar, tabs). Without `permission` every member of the business sees it.
 * `labelKey` is a common `nav.*` key; `icon` a lucide icon name the web app maps to its icon (an
 * unknown name gets a neutral one, so a new module shows without changes to the shell). `group`: where
 * the sidebar lists it (the business's sections, a named group such as "Sales", or Settings at the
 * foot). `tab`: its claim to a place in the phone's tab bar when the member's entries do not all fit
 * (1 first); without it the entry goes under "More" then. The tabs come in their claims' order (Release
 * A: an owner gets Home | Sales | + | Costs | More; an employee keeps Expenses, D-184).
 */
export interface NavEntry extends Omit<NavEntryDto, 'tab'> {
  readonly tab?: number
  /**
   * Entries that claim the same place share it: the one with the lowest rank (0 without one) among
   * those the member may use takes it, and the others are as if they claimed nothing. Orders takes the
   * Sales place for a business with Orders on (Q14).
   */
  readonly tabRank?: number
  readonly permission?: string
  /**
   * Also shown, whatever the member's keys, to a member the business owes (or paid back) for
   * something they paid from their own money in this module: "Owed to me" on Amounts owed (the
   * owner's answers of 2026-09-29, D-181). The page then shows them their own records only.
   */
  readonly payees?: true
}

export interface QuickAction extends QuickActionDto {
  readonly permission?: string
  /**
   * Keys the action needs besides `permission`, all of them: "New customer" opens Customers, so it is
   * for whoever sees customers as well as adds them.
   */
  readonly alsoNeeds?: readonly string[]
}

export interface ModuleManifest {
  readonly id: ModuleId
  readonly kind: ModuleKind
  /** Only released modules are ever shown (no placeholder screens). */
  readonly availability: ModuleAvailability
  /** Roadmap phase in which the module first ships (ROADMAP.md). */
  readonly phase: number
  /** Modules this one cannot work without (Customize BizCost warns before disabling them). */
  readonly deps: readonly ModuleId[]
  /** `module.resource.action` keys; each starts with the module id. */
  readonly permissionKeys: readonly string[]
  readonly nav: readonly NavEntry[]
  readonly quickActions: readonly QuickAction[]
  /** Sensitivity categories of the data this module outputs. */
  readonly sensitiveFields: readonly SensitivityCategory[]
  /** Capabilities the business must have for this module to make sense. */
  readonly requiresCapabilities: readonly CapabilityKey[]
}

const DASHBOARD = {
  id: 'dashboard',
  kind: 'core',
  availability: 'released',
  phase: 1,
  deps: [],
  permissionKeys: ['dashboard.home.view'],
  nav: [
    {
      id: 'dashboard',
      labelKey: 'nav.dashboard',
      path: '',
      icon: 'layout-dashboard',
      group: 'main',
      tab: 1,
      permission: 'dashboard.home.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Settings includes Locations (PRODUCT.md §7). Its nav entry has no permission: every member reaches
// their own profile and language there; each section checks its own key. Closing the books
// (`settings.books.close`, D-114 rule 6) is a Settings key since M2 Step 7 (D-201): purchases and
// expenses both obey the date, so it works with either of them on. Settings → Documents (numbers, the
// letterhead, the signature: `settings.documents.manage`, the Owner and the Admin, M3 Step 7) is
// served only while Quotations or Invoices is.
const SETTINGS = {
  id: 'settings',
  kind: 'core',
  availability: 'released',
  phase: 1,
  deps: [],
  permissionKeys: [
    'settings.business.view',
    'settings.business.edit',
    'settings.locations.manage',
    'settings.members.view',
    'settings.members.manage',
    'settings.roles.manage',
    'settings.modules.manage',
    'settings.books.close',
    'settings.documents.manage',
  ],
  nav: [
    {
      id: 'settings',
      labelKey: 'nav.settings',
      path: 'settings',
      icon: 'settings',
      group: 'system',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Products & Services (M2 Step 2; released with the Costing Core in Step 7). Recipes (M2 Step 4,
// D-149): what each product or service uses, and what its materials cost (`cost`). A recipe names
// materials, so its procedures also need the Materials module on. "+": a new product or service.
const PRODUCTS = {
  id: 'products',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: [
    'products.items.view',
    'products.items.manage',
    'products.recipes.view',
    'products.recipes.manage',
  ],
  nav: [
    {
      id: 'products',
      labelKey: 'nav.products',
      path: 'products',
      icon: 'tag',
      group: 'main',
      tab: 5,
      permission: 'products.items.view',
    },
  ],
  quickActions: [
    {
      id: 'new_product',
      labelKey: 'nav.new_product',
      path: 'products/new',
      icon: 'tag',
      permission: 'products.items.manage',
    },
  ],
  // The product cost (M2 Step 4): what its materials cost at their average.
  sensitiveFields: ['cost'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Materials (M2 Step 2; released in Step 7). Material cost comes only from purchases (PRODUCT.md
// §4.8), hence the dependency.
const MATERIALS = {
  id: 'materials',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: ['purchases'],
  permissionKeys: ['materials.items.view', 'materials.items.manage'],
  nav: [
    {
      id: 'materials',
      labelKey: 'nav.materials',
      path: 'materials',
      icon: 'package',
      group: 'main',
      tab: 7,
      permission: 'materials.items.view',
    },
  ],
  quickActions: [],
  // The cost view (M2 Step 3): its average cost, and its last purchase price.
  sensitiveFields: ['cost', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Suppliers (M2 Step 3; released in Step 7): a list of its own, separate from customers (D-112).
const SUPPLIERS = {
  id: 'suppliers',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: ['suppliers.items.view', 'suppliers.items.manage'],
  nav: [
    {
      id: 'suppliers',
      labelKey: 'nav.suppliers',
      path: 'suppliers',
      icon: 'truck',
      group: 'main',
      permission: 'suppliers.items.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Purchases (M2 Step 3; released in Step 7): purchases, supplier returns and credit notes, posted
// with the weighted average (D-114, D-120), their receipts (attachments), and what the business still
// owes on purchases bought on credit or paid by a member, with the payments of it (the owner's request of 2026-09-29, D-160; its own nav entry, "Amounts owed").
// Materials depend on it (their cost comes from purchases); the reverse would be a cycle, so
// Purchases lists no deps. The supplier of a purchase is optional (no dependency either). "+": a new
// purchase.
const PURCHASES = {
  id: 'purchases',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: [
    'purchases.documents.view',
    'purchases.documents.manage',
    'purchases.documents.post',
    'purchases.documents.reverse',
    'purchases.payments.view',
    'purchases.payments.record',
  ],
  nav: [
    {
      id: 'purchases',
      labelKey: 'nav.purchases',
      path: 'purchases',
      icon: 'shopping-cart',
      group: 'main',
      tab: 6,
      permission: 'purchases.documents.view',
    },
    {
      id: 'payables',
      labelKey: 'nav.payables',
      path: 'payables',
      icon: 'hand-coins',
      group: 'main',
      permission: 'purchases.payments.view',
      payees: true,
    },
  ],
  quickActions: [
    {
      id: 'new_purchase',
      labelKey: 'nav.new_purchase',
      path: 'purchases/new',
      icon: 'shopping-cart',
      permission: 'purchases.documents.manage',
    },
  ],
  sensitiveFields: ['cost', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Expenses (M2 Step 5; released in Step 7): one amount in a category (shared with Running Costs,
// D-116), its document type apart from how it was paid (PRODUCT.md §4 rule 13), receipts, and an
// optional approval before it is final (with a team, D-164). An expense bought on credit or paid by a
// member is owed until paid, next to purchases in "Amounts owed" (D-166): the page is one, listed by
// whichever module comes first (the registry lists a path once). Amounts are `supplier_price`
// (D-165). The supplier is optional, so no dependency on Suppliers. "+": a new expense (staff enter
// theirs, D-180).
const EXPENSES = {
  id: 'expenses',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: [
    'expenses.documents.view',
    'expenses.documents.manage',
    'expenses.documents.approve',
    'expenses.documents.post',
    'expenses.documents.reverse',
    'expenses.payments.view',
    'expenses.payments.record',
    'expenses.approval.manage',
  ],
  nav: [
    {
      id: 'expenses',
      labelKey: 'nav.expenses',
      path: 'expenses',
      icon: 'receipt',
      group: 'main',
      tab: 4,
      permission: 'expenses.documents.view',
    },
    {
      id: 'payables',
      labelKey: 'nav.payables',
      path: 'payables',
      icon: 'hand-coins',
      group: 'main',
      permission: 'expenses.payments.view',
      payees: true,
    },
  ],
  quickActions: [
    {
      id: 'new_expense',
      labelKey: 'nav.new_expense',
      path: 'expenses/new',
      icon: 'receipt',
      permission: 'expenses.documents.manage',
    },
  ],
  sensitiveFields: ['supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Running Costs (M2 Step 5; released in Step 7): "What do you pay to run your business?" Regular
// amounts per period in the categories shared with Expenses, counted with the expenses in each month's
// costs, which reach what the business sells by its price (D-202). Never posted. Amounts are `cost`
// (D-165).
const RUNNING_COSTS = {
  id: 'running_costs',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: ['running_costs.items.view', 'running_costs.items.manage'],
  nav: [
    {
      id: 'running_costs',
      labelKey: 'nav.running_costs',
      path: 'running-costs',
      icon: 'repeat',
      group: 'main',
      permission: 'running_costs.items.view',
    },
  ],
  quickActions: [],
  sensitiveFields: ['cost'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Cost Engine (M2 Step 6; released in Step 7): "Product costs", each product's cost for one unit
// sold, line by line (its materials at their averages, D-115; its share of the running costs by its
// price, worked out once sales are recorded, D-202; the owner's time without a team, D-119) and its
// margin on the price before VAT, worked out on read, with the business's costs of the last full
// month; and how it is worked out (the owner's hourly rate). Costs are `cost`, margins
// `profit_margin`, a material's last purchase price `supplier_price`. Its breakdown shows recipes, so
// seeing it needs seeing what goes into each product (PERMISSION_NEEDS).
const COST_ENGINE = {
  id: 'cost_engine',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: ['products'],
  permissionKeys: ['cost_engine.product_costs.view', 'cost_engine.settings.manage'],
  nav: [
    {
      id: 'product_costs',
      labelKey: 'nav.product_costs',
      path: 'product-costs',
      icon: 'calculator',
      group: 'main',
      tab: 3,
      permission: 'cost_engine.product_costs.view',
    },
  ],
  quickActions: [],
  sensitiveFields: ['cost', 'profit_margin', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Files (released with the Costing Core in Step 7): receipts and documents attached to records. It
// has no page of its own: its files show inside the records they belong to (a purchase's or an
// expense's receipts), and attachment.* need it on as well as the record's own module and keys. With
// it off, receipts are hidden in those screens and the API refuses them (MODULE_DISABLED). A
// receipt's download URL is a supplier price (it shows what was paid).
const FILES = {
  id: 'files',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: [],
  nav: [],
  quickActions: [],
  sensitiveFields: ['supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Sales (M3 Step 2; released with Release A in Step 6): Today's sales (one sheet per member, day and
// channel and branch, Q9, Q10) and One sale, finalized with the cost of what was sold frozen on the
// sale's day (D-219, D-222), and the business's sales channels. `sales.documents.view` sees every
// sale, and so the sales totals (H1); without it a member who enters sales sees only their own (D-181,
// D-214). A member limited to some branches sees and enters only theirs (Q12, member_locations). The
// cost snapshot, a delivery's cost and a channel's commission are `cost`. Its page is reached with
// either "see every sale" or "enter sales" (two entries of one page, listed once by buildModuleNav),
// first in the sidebar's "Sales" group. The phone's tab bar of Q14 (Home | Sales | + | Costs | More):
// claim 2, which it yields to Orders when the business has Orders on (Orders takes the Sales place).
// "+": Today's sales and a new sale, for those who enter sales.
const SALES = {
  id: 'sales',
  kind: 'core',
  availability: 'released',
  phase: 3,
  deps: ['products'],
  permissionKeys: [
    'sales.documents.view',
    'sales.documents.manage',
    'sales.documents.post',
    'sales.documents.reverse',
    'sales.channels.manage',
    'sales.imports.manage',
  ],
  nav: [
    {
      id: 'sales',
      labelKey: 'nav.sales',
      path: 'sales',
      icon: 'banknote',
      group: 'sales',
      tab: 2,
      tabRank: 1,
      permission: 'sales.documents.view',
    },
    {
      id: 'sales',
      labelKey: 'nav.sales',
      path: 'sales',
      icon: 'banknote',
      group: 'sales',
      tab: 2,
      tabRank: 1,
      permission: 'sales.documents.manage',
    },
  ],
  quickActions: [
    {
      id: 'today_sales',
      labelKey: 'nav.today_sales',
      path: 'sales/today',
      icon: 'calendar-check',
      permission: 'sales.documents.manage',
    },
    {
      id: 'new_sale',
      labelKey: 'nav.new_sale',
      path: 'sales/new',
      icon: 'banknote',
      permission: 'sales.documents.manage',
    },
  ],
  sensitiveFields: ['cost'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Orders (M3 Step 5; released with Release A): a customer's order with delivery, deposits and
// refunds, Pending → Delivered (it counts as a sale on its delivery day) or Cancelled, "Undo delivery"
// (Q16). "Orders / الطلبات" in every wording profile (Q19). `orders.documents.view` sees every order
// (it needs every sale seen, H1); without it a member who enters orders sees, changes and delivers only
// their own (Q10, D-214). `.manage` enters and changes pending orders and cancels them, `.deliver`
// delivers them, `.reverse` undoes a delivery and refunds a delivered order. Its page is reached with
// "see every order" or "enter orders" (two entries of one path, listed once), in the "Sales" group; on
// a phone it takes the Sales place (claim 2, rank 0, Q14). "+" offers a new order to those who enter
// them. The delivery cost is `cost`, the order's profit `profit_margin`. It needs Sales (Release A): a
// delivery is a sale of its day, refunded and reversed as a sale (sale.refund, the sale's page), so
// Customize turns Orders off with Sales and Sales on with Orders.
const ORDERS = {
  id: 'orders',
  kind: 'optional',
  availability: 'released',
  phase: 3,
  deps: ['products', 'sales', 'customers', 'payments'],
  permissionKeys: [
    'orders.documents.view',
    'orders.documents.manage',
    'orders.documents.deliver',
    'orders.documents.reverse',
  ],
  nav: [
    {
      id: 'orders',
      labelKey: 'nav.orders',
      path: 'orders',
      icon: 'clipboard-list',
      group: 'sales',
      tab: 2,
      permission: 'orders.documents.view',
    },
    {
      id: 'orders',
      labelKey: 'nav.orders',
      path: 'orders',
      icon: 'clipboard-list',
      group: 'sales',
      tab: 2,
      permission: 'orders.documents.manage',
    },
  ],
  quickActions: [
    {
      id: 'new_order',
      labelKey: 'nav.new_order',
      path: 'orders/new',
      icon: 'clipboard-list',
      permission: 'orders.documents.manage',
    },
  ],
  sensitiveFields: ['cost', 'profit_margin'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Customers (M3 Step 5; released with Release A): one list of the business's customers, apart from
// suppliers (D-112), names that may repeat ("Did you mean", Q2). `customers.items.view` lists them
// with their details; `.manage` adds and changes them. A member without `.view` who adds them (the
// Employee's quick add, Q10) changes none, and picks a customer by name and the phone's last 4 digits
// only (customer.pick). Nothing on a customer is a redaction category: their personal data is a
// permission. "+": a new customer, which opens Customers with its form, so it is for those who see
// customers and add them (the Employee adds one from an order's customer picker).
const CUSTOMERS = {
  id: 'customers',
  kind: 'core',
  availability: 'released',
  phase: 3,
  deps: [],
  permissionKeys: ['customers.items.view', 'customers.items.manage'],
  nav: [
    {
      id: 'customers',
      labelKey: 'nav.customers',
      path: 'customers',
      icon: 'users',
      group: 'sales',
      permission: 'customers.items.view',
    },
  ],
  quickActions: [
    {
      id: 'new_customer',
      labelKey: 'nav.new_customer',
      path: 'customers/new',
      icon: 'user-round-plus',
      permission: 'customers.items.manage',
      alsoNeeds: ['customers.items.view'],
    },
  ],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Payments (M3 Step 5; released with Release A): what customers pay on their orders and on sales
// "they'll pay later", and "What customers owe" («مستحقات العملاء»), one figure per obligation (Q17,
// A2), in the "Sales" group. `payments.customers.view` (it needs every sale seen, H1) lists them;
// `.record` records and reverses payments and money given back. Amounts are sales amounts: who sees
// them is a permission.
const PAYMENTS = {
  id: 'payments',
  kind: 'core',
  availability: 'released',
  phase: 3,
  deps: [],
  permissionKeys: ['payments.customers.view', 'payments.customers.record'],
  nav: [
    {
      id: 'receivables',
      labelKey: 'nav.receivables',
      path: 'receivables',
      icon: 'wallet',
      group: 'sales',
      permission: 'payments.customers.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Reports (M3 Step 3; released with Release A): Reports → Real profit («الربح الحقيقي»), the sidebar's
// "Reports" group, worked out on read from the posted sales, their frozen costs, the month's costs, the
// channels' fees and the owner's time (nothing stored, D-223). `reports.sales.view` opens it with the
// sales figures (which need every sale seen, H1); `reports.profit.view` adds the profit and what it is
// made of (Q11: with the costs switch and Product costs, PERMISSION_NEEDS). Profit is `profit_margin`,
// costs are `cost`. No deps: sales already posted still count with Sales switched off (Orders and
// Invoices post sales too, M9).
const REPORTS = {
  id: 'reports',
  kind: 'core',
  availability: 'released',
  phase: 3,
  deps: [],
  permissionKeys: ['reports.sales.view', 'reports.profit.view'],
  nav: [
    {
      id: 'real_profit',
      labelKey: 'nav.real_profit',
      path: 'reports/profit',
      icon: 'chart-line',
      group: 'reports',
      permission: 'reports.sales.view',
    },
  ],
  quickActions: [],
  sensitiveFields: ['cost', 'profit_margin'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Quotations (M3 Step 7; planned until Release B, M3 Step 9: served only under the dev-only preview,
// D-125): a customer's quotation with revisions frozen once sent, numbered Q-0001…, as a PDF on the
// business's own letterhead (Q21–Q25; the owner's document requests of 2026-10-16). Its keys and nav
// come with its build (D-124). `quotations.documents.view` sees the business's quotations (in one's
// branches, Q12); `.manage` prepares, sends, revises, copies, discards and turns an accepted one into
// an order; `.decide` records the customer's answer (accepted or declined). Prices are not sensitive
// (D-187). "+ New quotation" comes with Release B. It needs Products & Services (its lines) and
// Customers ("Dear …").
const QUOTATIONS = {
  id: 'quotations',
  kind: 'optional',
  availability: 'planned',
  phase: 3,
  deps: ['products', 'customers'],
  permissionKeys: [
    'quotations.documents.view',
    'quotations.documents.manage',
    'quotations.documents.decide',
  ],
  nav: [
    {
      id: 'quotations',
      labelKey: 'nav.quotations',
      path: 'quotations',
      icon: 'file-text',
      group: 'sales',
      permission: 'quotations.documents.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Invoices (M3 Step 8; planned until Release B, M3 Step 9: served only under the dev-only preview,
// D-125): invoices and credit notes numbered gaplessly at issue (INV-0001…, CN-0001…), a full «فاتورة
// ضريبية · Tax Invoice» with VAT registration and a plain «فاتورة · Invoice» without it (Q26), made from
// scratch, an accepted quotation (in stages or with deposits, Q22), an order or a recorded sale, paid
// through Payments, and the customers' statements (Q27). `invoices.documents.view` sees them (in one's
// branches, Q12); `.manage` prepares drafts and copies an invoice to a quotation; `.issue` issues them
// (the number is taken, it is frozen); `.credit` prepares and issues credit notes. Prices are not
// sensitive (D-187). It needs Products & Services, Customers and Payments. No requiresCapabilities: a
// business that is not VAT-registered sends plain invoices (§6.6).
const INVOICES = {
  id: 'invoices',
  kind: 'optional',
  availability: 'planned',
  phase: 3,
  deps: ['products', 'customers', 'payments'],
  permissionKeys: [
    'invoices.documents.view',
    'invoices.documents.manage',
    'invoices.documents.issue',
    'invoices.documents.credit',
  ],
  nav: [
    {
      id: 'invoices',
      labelKey: 'nav.invoices',
      path: 'invoices',
      icon: 'receipt-text',
      group: 'sales',
      permission: 'invoices.documents.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

interface PlannedManifest extends ModuleManifest {
  readonly availability: 'planned'
  readonly permissionKeys: readonly []
  readonly nav: readonly []
  readonly quickActions: readonly []
}

function planned(
  id: ModuleId,
  kind: ModuleKind,
  phase: number,
  links: {
    deps?: readonly ModuleId[]
    requiresCapabilities?: readonly CapabilityKey[]
  } = {},
): PlannedManifest {
  return {
    id,
    kind,
    availability: 'planned',
    phase,
    deps: links.deps ?? [],
    permissionKeys: [],
    nav: [],
    quickActions: [],
    sensitiveFields: [],
    requiresCapabilities: links.requiresCapabilities ?? [],
  }
}

// Same order as MODULE_IDS. deps/requiresCapabilities follow PRODUCT.md §5–§7 (Smart Setup relies on
// them, §6.6) and are reviewed when each module is built.
export const MODULES = [
  DASHBOARD,
  SETTINGS,
  PRODUCTS,
  MATERIALS,
  SUPPLIERS,
  PURCHASES,
  EXPENSES,
  RUNNING_COSTS,
  FILES,
  COST_ENGINE,
  SALES,
  ORDERS,
  CUSTOMERS,
  PAYMENTS,
  REPORTS,
  QUOTATIONS,
  INVOICES,
  planned('inventory', 'optional', 4, {
    deps: ['materials'],
    requiresCapabilities: ['keeps_stock'],
  }),
  planned('usage_waste', 'optional', 4, {
    deps: ['inventory'],
    requiresCapabilities: ['keeps_stock'],
  }),
  planned('employees', 'optional', 5, { requiresCapabilities: ['has_team'] }),
  planned('attendance', 'optional', 5, {
    deps: ['employees'],
    requiresCapabilities: ['has_team'],
  }),
  planned('payroll', 'optional', 5, { deps: ['employees'], requiresCapabilities: ['has_team'] }),
  planned('equipment', 'optional', 5, { requiresCapabilities: ['uses_machines'] }),
  planned('vehicles', 'optional', 5),
  planned('projects', 'optional', 5, { deps: ['customers', 'payments'] }),
  planned('petty_cash', 'optional', 5, {
    deps: ['employees'],
    requiresCapabilities: ['has_team'],
  }),
  planned('vat_center', 'optional', 5, { requiresCapabilities: ['vat_registered'] }),
] as const satisfies readonly ModuleManifest[]

/** Permission keys declared by module manifests (the data-visibility keys are added in the catalog). */
export type ModulePermissionKey = (typeof MODULES)[number]['permissionKeys'][number]

/**
 * Core modules that are always on: the business cannot switch them off, and business_modules rows for
 * them are ignored. Other core modules are on until a row switches them off; optional modules are on
 * only through an enabled row (resolveEnabledModules).
 */
export const ALWAYS_ENABLED_MODULE_IDS: readonly ModuleId[] = ['dashboard', 'settings']
