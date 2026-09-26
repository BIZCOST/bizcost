import type { Locale } from '@bizcost/domain'
import { createI18nInstance, type I18n } from './instance'
import { DEFAULT_NAMESPACE, FALLBACK_LOCALE, NAMESPACES, type Namespace } from './namespaces'
import { pickMessages } from './resources'

export interface CreateI18nOptions {
  locale: Locale
  /** Namespaces to load; `common` is always included. Default: all. */
  namespaces?: readonly Namespace[]
}

/**
 * A NEW, initialized i18next instance with every message of the namespaces asked for, in `locale` and
 * in English (the fallback). For the Next server, which creates one per request inside React `cache()`
 * and never calls `changeLanguage` on a shared instance, and for the API. The browser builds its
 * instance from the messages the server passes it (createI18nInstance, D-092).
 */
export function createI18n({ locale, namespaces = NAMESPACES }: CreateI18nOptions): I18n {
  const ns = [...new Set<Namespace>([DEFAULT_NAMESPACE, ...namespaces])]
  return createI18nInstance({
    locale,
    messages: Object.fromEntries(
      [...new Set<Locale>([locale, FALLBACK_LOCALE])].map((lng) => [lng, pickMessages(lng, ns)]),
    ),
  })
}
