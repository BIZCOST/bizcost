import { isLocale, type Locale } from '@bizcost/domain'

/** Locale of a new visitor whose browser asks for neither Arabic nor English. */
export const DEFAULT_LOCALE = 'ar' satisfies Locale

/** Cookie that remembers the chosen language on web (no locale segment in URLs). */
export const LOCALE_COOKIE = 'bz_locale'
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export type Direction = 'ltr' | 'rtl'

export function dir(locale: Locale): Direction {
  return locale === 'ar' ? 'rtl' : 'ltr'
}

/** BCP 47 tag for Intl: Arabic shows Latin digits by default (docs/PRODUCT.md §13). */
export function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-AE'
}

/**
 * The locale an Accept-Language header prefers: the highest-weighted `ar*` or `en*` entry, else
 * DEFAULT_LOCALE. Entries with q=0 are refused.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  const ranges = (acceptLanguage ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.map((p) => /^\s*q=([01](?:\.\d{0,3})?)\s*$/i.exec(p)?.[1]).find(Boolean)
      return { primary: tag.trim().toLowerCase().split('-')[0] ?? '', q: q ? Number(q) : 1, index }
    })
    .filter((range) => range.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
  const match = ranges.find((range) => isLocale(range.primary))
  return match && isLocale(match.primary) ? match.primary : DEFAULT_LOCALE
}

export interface LocaleSources {
  /** `profiles.locale` of the signed-in user, when known. */
  profile?: unknown
  /** The `bz_locale` cookie (web) or the saved choice (mobile). */
  saved?: unknown
  /** The Accept-Language header (web). */
  acceptLanguage?: string | null
}

/** Locale order (docs/ARCHITECTURE.md §i18n & RTL): profile → saved choice → Accept-Language → 'ar'. */
export function resolveLocale({ profile, saved, acceptLanguage }: LocaleSources): Locale {
  if (isLocale(profile)) return profile
  if (isLocale(saved)) return saved
  return negotiateLocale(acceptLanguage)
}
