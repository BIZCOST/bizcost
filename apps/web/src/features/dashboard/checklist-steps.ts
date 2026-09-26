import type { ChecklistItemDto, ChecklistItemId } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import {
  MapPinnedIcon,
  ReceiptTextIcon,
  StoreIcon,
  UserRoundPlusIcon,
  type LucideIcon,
} from 'lucide-react'
import { sectionPath, type SettingsSection } from '@/features/settings/sections'

// How the Dashboard shows each checklist step (D-090): its icon, its words, and the settings section
// where the member does it.

const STEPS: Readonly<
  Record<ChecklistItemId, { icon: LucideIcon; section: SettingsSection; key: string }>
> = {
  profile: { icon: StoreIcon, section: 'business', key: 'profile' },
  trn: { icon: ReceiptTextIcon, section: 'business', key: 'trn' },
  invite: { icon: UserRoundPlusIcon, section: 'members', key: 'invite' },
  location: { icon: MapPinnedIcon, section: 'locations', key: 'location' },
}

export interface ChecklistStepView {
  readonly id: ChecklistItemId
  readonly done: boolean
  readonly icon: LucideIcon
  readonly titleKey: I18nKey
  /** What is left to do, or what was done. */
  readonly bodyKey: I18nKey
  readonly actionKey: I18nKey
  readonly href: string
}

function profileBody(item: ChecklistItemDto): string {
  if (item.done) return 'done'
  const arabic = item.missing.includes('arabicName')
  const logo = item.missing.includes('logo')
  if (arabic && logo) return 'missingBoth'
  return arabic ? 'missingArabicName' : 'missingLogo'
}

export function stepView(businessId: string, item: ChecklistItemDto): ChecklistStepView {
  const step = STEPS[item.id]
  const base = `dashboard.checklist.items.${step.key}`
  const body = item.id === 'profile' ? profileBody(item) : item.done ? 'done' : 'todo'
  return {
    id: item.id,
    done: item.done,
    icon: step.icon,
    titleKey: `${base}.title` as I18nKey,
    bodyKey: `${base}.${body}` as I18nKey,
    actionKey: `${base}.action` as I18nKey,
    href: sectionPath(businessId, step.section),
  }
}

/** "n of m done", and whether every step is done (then "You're all set" takes the list's place). */
export function progressOf(items: readonly ChecklistItemDto[]): {
  done: number
  total: number
  complete: boolean
} {
  const done = items.filter((item) => item.done).length
  return { done, total: items.length, complete: items.length > 0 && done === items.length }
}
