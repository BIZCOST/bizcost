'use client'

import { hasKey } from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'
import { useBusinessContext } from '@/lib/trpc/client'
import { businessWording, type NavWording } from './nav'

/**
 * The business's wording for the shell's labels (businessWording in nav.ts): for a business that sells
 * only services a label's services words when it has them (`navShort.products_services`: "Services",
 * `nav.new_product_services`: "New service"); else its terminology overlay for the business's profile
 * when the page has one (`nav.materials_food`: "Ingredients & supplies"); else the label itself.
 */
export function useNavWording(): NavWording {
  const { i18n } = useTranslation()
  const { data: context } = useBusinessContext()
  return businessWording(
    {
      profile: context?.terminologyProfile,
      servicesOnly: context?.sellsOnlyServices === true,
    },
    (key) => hasKey(i18n, key),
  )
}
