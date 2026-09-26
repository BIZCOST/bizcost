import { LOCALES, type Locale } from '@bizcost/domain'
import i18next, { type i18n } from 'i18next'
import {
  DEFAULT_NAMESPACE,
  FALLBACK_LOCALE,
  NAMESPACES,
  type MessageBundle,
  type Messages,
} from './namespaces'

export type I18n = i18n

export interface CreateI18nInstanceOptions {
  locale: Locale
  /** The messages to start with, by language; the instance can take more later (addMessages). */
  messages: Readonly<Partial<Record<Locale, MessageBundle>>>
}

/**
 * A NEW, initialized i18next instance from the messages given (no loading step: `t` works at once).
 * Every namespace is declared, so a `<namespace>.<path>` key always names its namespace, also before
 * that namespace's messages arrive (addMessages). Falls back to English only when English messages
 * were given (the server gives them; the browser gets the page's language only).
 */
export function createI18nInstance({ locale, messages }: CreateI18nInstanceOptions): I18n {
  const instance = i18next.createInstance()
  void instance.init({
    lng: locale,
    fallbackLng: locale !== FALLBACK_LOCALE && messages[FALLBACK_LOCALE] ? FALLBACK_LOCALE : false,
    supportedLngs: [...LOCALES],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    nsSeparator: '.',
    keySeparator: '.',
    resources: Object.fromEntries(
      Object.entries(messages).map(([lng, bundle]) => [lng, { ...bundle }]),
    ),
    initAsync: false,
    returnEmptyString: false,
    // React escapes rendered text; messages never hold HTML.
    interpolation: { escapeValue: false },
  })
  return instance
}

/**
 * Adds messages of `locale` to an instance: namespaces it does not have yet, and the missing parts of
 * those it has (a page may have received only part of a namespace). Existing messages are kept, so
 * adding the same messages again changes nothing.
 */
export function addMessages(instance: I18n, locale: Locale, bundle: MessageBundle): void {
  for (const [namespace, messages] of Object.entries(bundle) as [string, Messages][]) {
    instance.addResourceBundle(locale, namespace, messages, true, false)
  }
}

/**
 * Whether the instance has a message for `key` (`<namespace>.<path>`), also when the key has plural
 * forms only (`<path>_other`).
 */
export function hasKey(instance: I18n, key: string): boolean {
  return instance.exists(key) || instance.exists(`${key}_other`)
}
