'use client'

import { hasKey, terminologyKey, type I18nKey } from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'
import { useBusinessContext } from '@/lib/trpc/client'
import type { NavWording } from './nav'

/**
 * The business's wording for the shell's labels (docs/ARCHITECTURE.md §i18n & RTL): for a business
 * that sells only services (business.context's `sellsOnlyServices`, D-200) a label's services words
 * when it has them (`navShort.products_services`: "Services", `nav.new_product_services`: "New
 * service"); else its terminology overlay for the business's profile when the page has one
 * (`nav.materials_food`: "Ingredients & supplies"); else the label itself.
 */
export function useNavWording(): NavWording {
  const { i18n } = useTranslation()
  const { data: context } = useBusinessContext()
  const profile = context?.terminologyProfile
  const servicesOnly = context?.sellsOnlyServices === true
  const has = (key: string) => hasKey(i18n, key)
  return (labelKey) => {
    const services = `${labelKey}_services`
    if (servicesOnly && has(services)) return services as I18nKey
    return terminologyKey(labelKey, profile, has)
  }
}
