'use client'

import { useMe } from '@bizcost/app-core'
import { businessDisplayName } from '@bizcost/domain'
import { useLocale } from '@/lib/i18n/client'

/**
 * The business's name as the app shows it in the page's language (businessDisplayName, D-097), from
 * `me`; '' while it is not known.
 */
export function useBusinessName(businessId: string): string {
  const { data: me } = useMe()
  const { locale } = useLocale()
  const membership = me?.memberships.find((m) => m.businessId === businessId)
  return membership ? businessDisplayName(membership, locale) : ''
}
