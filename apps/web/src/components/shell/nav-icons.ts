import {
  HandCoinsIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  PackageIcon,
  PlusIcon,
  ReceiptIcon,
  RepeatIcon,
  SettingsIcon,
  ShoppingCartIcon,
  TagIcon,
  TruckIcon,
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
}

export const FALLBACK_NAV_ICON: LucideIcon = LayoutGridIcon

export function navIcon(name: string): LucideIcon {
  return NAV_ICONS[name] ?? FALLBACK_NAV_ICON
}
