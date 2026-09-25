import type {
  HowYouMake,
  ModuleId,
  SalesChannel,
  StatementKey,
  TeamAnswer,
  TeamTracking,
  VatAnswer,
  WhatYouDo,
  Workplace,
  WorkSetup,
} from '@bizcost/modules'
import {
  BadgeCheckIcon,
  BanknoteIcon,
  BoxesIcon,
  BoxIcon,
  Building2Icon,
  CalculatorIcon,
  ChartColumnIcon,
  ChartPieIcon,
  ChefHatIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  CircleSlashIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  ClockIcon,
  CoffeeIcon,
  CogIcon,
  ContactIcon,
  EllipsisIcon,
  FactoryIcon,
  FileTextIcon,
  GlobeIcon,
  HammerIcon,
  HandCoinsIcon,
  HandshakeIcon,
  HardHatIcon,
  HouseIcon,
  LayersIcon,
  LayoutGridIcon,
  MapPinIcon,
  MapPinnedIcon,
  MessageCircleIcon,
  PaintbrushIcon,
  PaperclipIcon,
  PencilRulerIcon,
  PercentIcon,
  ReceiptIcon,
  ReceiptTextIcon,
  ScanBarcodeIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
  StoreIcon,
  Trash2Icon,
  TruckIcon,
  UserRoundIcon,
  UsersRoundIcon,
  WalletIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react'

// Pictures for Smart Setup's options, sections and statements (UI only; the question set is data in
// @bizcost/modules). Typed per option list, so a new option cannot be left without an icon.

interface OptionIcons {
  what_you_do: Record<WhatYouDo, LucideIcon>
  how_you_make: Record<HowYouMake, LucideIcon>
  workplace: Record<Workplace, LucideIcon>
  team: Record<TeamAnswer, LucideIcon>
  team_tracking: Record<TeamTracking, LucideIcon>
  work_setup: Record<WorkSetup, LucideIcon>
  sales_channels: Record<SalesChannel, LucideIcon>
  vat: Record<VatAnswer, LucideIcon>
}

const OPTION_ICONS: OptionIcons = {
  what_you_do: {
    sell_products: ShoppingBagIcon,
    make_products: HammerIcon,
    food_drinks: CoffeeIcon,
    services: WrenchIcon,
    projects: HardHatIcon,
    other: EllipsisIcon,
  },
  how_you_make: { catalog: LayoutGridIcon, custom_jobs: PencilRulerIcon, batches: FactoryIcon },
  workplace: {
    home: HouseIcon,
    shop: StoreIcon,
    office: Building2Icon,
    workshop: WrenchIcon,
    factory: FactoryIcon,
    kitchen: ChefHatIcon,
    customer_sites: MapPinIcon,
  },
  team: { alone: UserRoundIcon, team: UsersRoundIcon },
  team_tracking: {
    hours: ClockIcon,
    salaries: BanknoteIcon,
    staff_cash: HandCoinsIcon,
    cost_only: CalculatorIcon,
  },
  work_setup: {
    materials: PaintbrushIcon,
    stock: BoxesIcon,
    machines: CogIcon,
    vehicles: TruckIcon,
    none: CircleSlashIcon,
  },
  sales_channels: {
    walk_in: StoreIcon,
    messages: MessageCircleIcon,
    online: GlobeIcon,
    quotes: FileTextIcon,
    invoice_later: ReceiptTextIcon,
  },
  vat: { yes: BadgeCheckIcon, no: CircleMinusIcon, not_sure: CircleHelpIcon },
}

/** The option's icon; yes/no questions have none. */
export function optionIcon(questionId: string, optionId: string): LucideIcon | null {
  const icons = (OPTION_ICONS as unknown as Record<string, Record<string, LucideIcon>>)[questionId]
  return icons?.[optionId] ?? null
}

type ListedModule = Exclude<ModuleId, 'dashboard' | 'settings'>

const MODULE_ICONS: Record<ListedModule, LucideIcon> = {
  products: BoxIcon,
  materials: LayersIcon,
  suppliers: HandshakeIcon,
  purchases: ShoppingCartIcon,
  expenses: ReceiptIcon,
  running_costs: ZapIcon,
  files: PaperclipIcon,
  cost_engine: CalculatorIcon,
  customers: ContactIcon,
  sales: ChartColumnIcon,
  payments: WalletIcon,
  reports: ChartPieIcon,
  orders: ClipboardListIcon,
  quotations: FileTextIcon,
  invoices: ReceiptTextIcon,
  inventory: BoxesIcon,
  usage_waste: Trash2Icon,
  employees: UsersRoundIcon,
  attendance: ClockIcon,
  payroll: BanknoteIcon,
  equipment: CogIcon,
  vehicles: TruckIcon,
  projects: HardHatIcon,
  petty_cash: HandCoinsIcon,
  vat_center: PercentIcon,
}

export function moduleIcon(id: ModuleId): LucideIcon {
  return MODULE_ICONS[id as ListedModule] ?? BoxIcon
}

/** The "cost of each job" row (the jobs_and_tasks capability). */
export const JOBS_ICON = ClipboardCheckIcon

/** Capability statements (review "About your business", business home summary). */
export const STATEMENT_ICONS: Record<StatementKey | 'jobs_and_tasks', LucideIcon> = {
  has_team: UsersRoundIcon,
  multi_location: MapPinnedIcon,
  keeps_stock: BoxesIcon,
  uses_machines: CogIcon,
  sells_via_pos: ScanBarcodeIcon,
  vat_registered: PercentIcon,
  jobs_and_tasks: ClipboardCheckIcon,
}
