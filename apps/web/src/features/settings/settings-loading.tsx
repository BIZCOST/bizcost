'use client'

import { useParams, usePathname } from 'next/navigation'
import { SectionSkeleton } from '@/components/states/query-state'
import { sectionOfPath, type SettingsSection } from './sections'
import { SectionPage, SettingsHome } from './settings-shell'

/** The placeholder cards each section shows while its data loads (the same number as its page). */
const SKELETON_CARDS: Readonly<Record<SettingsSection, number>> = {
  business: 3,
  locations: 1,
  members: 1,
  roles: 3,
  modules: 3,
  language: 1,
}

/**
 * A settings page on its way (loading.tsx): the settings home as it is (it needs only the shell's
 * data), or the section's title with the placeholders its page shows first, so nothing moves when the
 * page arrives. A section the member may not open says so at once.
 */
export function SettingsLoading() {
  const { businessId } = useParams<{ businessId: string }>()
  const section = sectionOfPath(usePathname())
  if (!section) return <SettingsHome businessId={businessId} />
  return (
    <SectionPage businessId={businessId} section={section}>
      <SectionSkeleton cards={SKELETON_CARDS[section]} />
    </SectionPage>
  )
}
