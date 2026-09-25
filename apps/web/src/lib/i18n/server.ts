import 'server-only'
import { createI18n, LOCALE_COOKIE, resolveLocale, type Locale } from '@bizcost/i18n'
import { cookies, headers } from 'next/headers'
import { cache } from 'react'

// Locale of the current request (docs/ARCHITECTURE.md §i18n & RTL): the bz_locale cookie, then
// Accept-Language, then Arabic. A signed-in user's profile.locale is applied by writing the cookie
// (the (app) layout syncs it), so every page reads the same source without a database call.

export const getLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  return resolveLocale({
    saved: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get('accept-language'),
  })
})

/** One i18next instance per request (never changeLanguage on a shared instance). */
export const getI18n = cache(async () => createI18n({ locale: await getLocale() }))

/** `t` of the current request, for server components and metadata. */
export async function getT() {
  return (await getI18n()).t
}
