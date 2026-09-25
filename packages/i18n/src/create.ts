import { LOCALES, type Locale } from '@bizcost/domain'
import i18next, { type i18n } from 'i18next'
import {
  DEFAULT_NAMESPACE,
  FALLBACK_LOCALE,
  NAMESPACES,
  resources,
  type Messages,
  type Namespace,
} from './resources'

export type I18n = i18n

export interface CreateI18nOptions {
  locale: Locale
  /** Namespaces to load; `common` is always included. Default: all. */
  namespaces?: readonly Namespace[]
}

/**
 * A NEW, initialized i18next instance on every call (resources are bundled, so `t` works at once).
 * The Next server creates one per request inside React `cache()` and never calls `changeLanguage` on a
 * shared instance; apps pass the instance to react-i18next's `I18nextProvider`.
 */
export function createI18n({ locale, namespaces = NAMESPACES }: CreateI18nOptions): I18n {
  const ns = [...new Set<Namespace>([DEFAULT_NAMESPACE, ...namespaces])]
  const pick = (lng: Locale): Record<string, Messages> =>
    Object.fromEntries(ns.map((name) => [name, resources[lng][name]]))

  const instance = i18next.createInstance()
  void instance.init({
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...LOCALES],
    ns,
    defaultNS: DEFAULT_NAMESPACE,
    nsSeparator: '.',
    keySeparator: '.',
    resources: Object.fromEntries(
      [...new Set<Locale>([locale, FALLBACK_LOCALE])].map((lng) => [lng, pick(lng)]),
    ),
    initAsync: false,
    returnEmptyString: false,
    // React escapes rendered text; messages never hold HTML.
    interpolation: { escapeValue: false },
  })
  return instance
}
