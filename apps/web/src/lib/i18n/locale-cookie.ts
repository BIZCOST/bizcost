import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_SECONDS, type Locale } from '@bizcost/i18n'

/** Remembers the chosen language in this browser (read by the server on every request). */
export function saveLocaleCookie(locale: Locale): void {
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure}`
}
