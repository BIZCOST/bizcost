'use client'

import { hasKey, terminologyKey } from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'
import { useBusinessContext } from '@/lib/trpc/client'
import type { NavWording } from './nav'

/**
 * The business's wording for the shell's labels (docs/ARCHITECTURE.md §i18n & RTL): a label's
 * terminology overlay for the business's profile when the page has one (`nav.materials_food`:
 * "Ingredients & supplies"), else the label itself.
 */
export function useNavWording(): NavWording {
  const { i18n } = useTranslation()
  const { data: context } = useBusinessContext()
  const profile = context?.terminologyProfile
  return (labelKey) => terminologyKey(labelKey, profile, (key) => hasKey(i18n, key))
}
