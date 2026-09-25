import {
  LanguagesIcon,
  LayoutGridIcon,
  MapPinnedIcon,
  ShieldCheckIcon,
  StoreIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react'
import type { SettingsSection } from './sections'

export const SECTION_ICONS: Readonly<Record<SettingsSection, LucideIcon>> = {
  business: StoreIcon,
  locations: MapPinnedIcon,
  members: UsersRoundIcon,
  roles: ShieldCheckIcon,
  modules: LayoutGridIcon,
  language: LanguagesIcon,
}
