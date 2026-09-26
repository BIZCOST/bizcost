import {
  LayoutDashboardIcon,
  LayoutGridIcon,
  PlusIcon,
  SettingsIcon,
  type LucideIcon,
} from 'lucide-react'

// Icons of the manifests' nav entries and "+" actions, by lucide name. Only the icons of released
// modules are here (the bundle holds no others); a name that is not here gets a neutral icon, so a
// newly released module shows before its icon is added.

const NAV_ICONS: Readonly<Record<string, LucideIcon>> = {
  'layout-dashboard': LayoutDashboardIcon,
  settings: SettingsIcon,
  plus: PlusIcon,
}

export const FALLBACK_NAV_ICON: LucideIcon = LayoutGridIcon

export function navIcon(name: string): LucideIcon {
  return NAV_ICONS[name] ?? FALLBACK_NAV_ICON
}
