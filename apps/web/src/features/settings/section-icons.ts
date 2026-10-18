import {
  BookLockIcon,
  CalculatorIcon,
  CircleCheckBigIcon,
  FileTextIcon,
  LanguagesIcon,
  LayoutGridIcon,
  MapPinnedIcon,
  ShieldCheckIcon,
  StoreIcon,
  TagsIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react'
import type { SettingsSection } from './sections'

export const SECTION_ICONS: Readonly<Record<SettingsSection, LucideIcon>> = {
  business: StoreIcon,
  locations: MapPinnedIcon,
  channels: TagsIcon,
  documents: FileTextIcon,
  members: UsersRoundIcon,
  roles: ShieldCheckIcon,
  modules: LayoutGridIcon,
  books: BookLockIcon,
  approval: CircleCheckBigIcon,
  costing: CalculatorIcon,
  language: LanguagesIcon,
}
