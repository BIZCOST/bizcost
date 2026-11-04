import { apiErrorCode, apiErrorKey, apiErrorMaterials, apiErrorNames } from '@bizcost/app-core'
import type { AppErrorCode } from '@bizcost/contracts'
import type { Locale } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'
import { listOfNames } from '@/features/catalog/names'

// A refusal said with the names it is about (M4 Step 2): STOCK_TRACKED and STOCK_NOT_TRACKED name
// the materials of a count, STOCK_COUNTED those of a purchase or a return, BRANCH_HAS_STOCK the
// removed branches and the materials they hold, STOCK_USED_SINCE the materials of a first count.
// Their messages (`errors.named.<code>`) say those names; without names, the plain message.

/** What a screen says for a refusal: a message, with the values it takes when it names things. */
export type Refusal =
  I18nKey | { readonly key: I18nKey; readonly values: Readonly<Record<string, unknown>> }

/** The refusals said with their names, and the message that says them. */
const NAMED: Partial<Record<AppErrorCode, I18nKey>> = {
  stock_tracked: 'errors.named.stock_tracked',
  stock_not_tracked: 'errors.named.stock_not_tracked',
  stock_counted: 'errors.named.stock_counted',
  branch_has_stock: 'errors.named.branch_has_stock',
  stock_used_since: 'errors.named.stock_used_since',
}

/**
 * The message for a failed call: the named one when the server sent the names it needs, else
 * `fallback` (the screen's own words for the code) or the code's plain message.
 */
export function refusalOf(error: unknown, locale: Locale, fallback?: I18nKey): Refusal {
  const code = apiErrorCode(error)
  const named = code ? NAMED[code] : undefined
  const names = apiErrorNames(error)
  if (named && names.length > 0) {
    if (code !== 'branch_has_stock')
      return { key: named, values: { names: listOfNames(locale, names) } }
    const items = apiErrorMaterials(error)
    if (items.length > 0) {
      return {
        key: named,
        values: { names: listOfNames(locale, names), items: listOfNames(locale, items) },
      }
    }
  }
  return fallback ?? apiErrorKey(error)
}

/** Says a refusal in the page's language. */
export function useSayRefusal(): (refusal: Refusal) => string {
  const { t } = useTranslation()
  return (refusal) => (typeof refusal === 'string' ? t(refusal) : t(refusal.key, refusal.values))
}
