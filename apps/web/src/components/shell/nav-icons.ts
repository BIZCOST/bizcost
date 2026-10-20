import {
  BanknoteIcon,
  CalculatorIcon,
  CalendarCheckIcon,
  ChartLineIcon,
  ClipboardListIcon,
  FileTextIcon,
  HandCoinsIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  PackageIcon,
  PlusIcon,
  ReceiptIcon,
  ReceiptTextIcon,
  RepeatIcon,
  SettingsIcon,
  ShoppingCartIcon,
  TagIcon,
  TruckIcon,
  UserRoundPlusIcon,
  UsersRoundIcon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react'

// Icons of the manifests' nav entries and "+" actions, by lucide name. Only the icons of released
// modules (and of modules being built, which show only in the dev-only preview, D-125) are here: the
// bundle holds no others. A name that is not here gets a neutral icon, so a newly released module
// shows before its icon is added.

const NAV_ICONS: Readonly<Record<string, LucideIcon>> = {
  'layout-dashboard': LayoutDashboardIcon,
  settings: SettingsIcon,
  plus: PlusIcon,
  // Products & Services and Materials (M2 Step 2).
  tag: TagIcon,
  package: PackageIcon,
  // Suppliers and Purchases (M2 Step 3).
  truck: TruckIcon,
  'shopping-cart': ShoppingCartIcon,
  // Amounts owed (the Purchases module's second entry, 2026-09-29; Expenses' too, D-166).
  'hand-coins': HandCoinsIcon,
  // Expenses and Running Costs (M2 Step 5).
  receipt: ReceiptIcon,
  repeat: RepeatIcon,
  // Product costs (the Cost Engine, M2 Step 6).
  calculator: CalculatorIcon,
  // Sales, a new sale and Today's sales (M3 Step 2; released with Release A, Step 6).
  banknote: BanknoteIcon,
  'calendar-check': CalendarCheckIcon,
  // Reports → Real profit (M3 Step 3; Release A).
  'chart-line': ChartLineIcon,
  // Customers, Orders and What customers owe (M3 Step 5; Release A), and a new customer.
  users: UsersRoundIcon,
  'user-round-plus': UserRoundPlusIcon,
  'clipboard-list': ClipboardListIcon,
  wallet: WalletIcon,
  // Quotations (M3 Step 7) and Invoices (M3 Step 8; the dev-only preview until Release B, Step 9).
  'file-text': FileTextIcon,
  'receipt-text': ReceiptTextIcon,
}

export const FALLBACK_NAV_ICON: LucideIcon = LayoutGridIcon

/** Whether the shell has its own icon for `name` (not the neutral one). */
export function hasNavIcon(name: string): boolean {
  return name in NAV_ICONS
}

export function navIcon(name: string): LucideIcon {
  return NAV_ICONS[name] ?? FALLBACK_NAV_ICON
}
