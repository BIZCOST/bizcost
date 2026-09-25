'use client'

import { intlLocale, terminologyKey } from '@bizcost/i18n'
import { MODULE_IDS, moduleNameKey, type ModuleId } from '@bizcost/modules'
import { useTranslation } from 'react-i18next'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value)
}

/**
 * Module ids (e.g. the modules switching VAT turned on) as one list of names in the business's
 * wording: "VAT Center and Invoices".
 */
export function useModuleNames() {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const { data: context } = useBusinessContext()
  const profile = context?.terminologyProfile
  return (ids: readonly string[]): string =>
    new Intl.ListFormat(intlLocale(locale), { type: 'conjunction' }).format(
      ids.filter(isModuleId).map((id) => t(terminologyKey(moduleNameKey(id), profile))),
    )
}
