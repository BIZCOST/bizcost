'use client'

import { useMe } from '@bizcost/app-core'
import { businessDisplayName } from '@bizcost/domain'
import { activeMemberships } from '@/features/business/memberships'
import { useLocale } from '@/lib/i18n/client'
import { ReadyStep } from './ready-step'
import { SetupWizard } from './wizard'

/**
 * Smart Setup: the wizard, or its "ready" screen once the business named by `?done=` exists (a reload
 * keeps it; opening /setup again starts a new business).
 */
export function SetupView({ done }: { done: string | null }) {
  const { data: me } = useMe()
  const { locale } = useLocale()
  if (!me) return null
  const created = done ? activeMemberships(me).find((m) => m.businessId === done) : undefined
  if (created) {
    return <ReadyStep businessId={created.businessId} name={businessDisplayName(created, locale)} />
  }
  return <SetupWizard userId={me.profile.id} />
}
