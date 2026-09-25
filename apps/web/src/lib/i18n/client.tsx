'use client'

import { createI18n, dir, type Direction, type Locale } from '@bizcost/i18n'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

// The browser side of i18n: the server passes the request's locale, and a NEW instance is created
// whenever it changes (a language switch refreshes the page from the server). Resources are bundled,
// so there is no loading step.

const LocaleContext = createContext<{ locale: Locale; dir: Direction }>({
  locale: 'ar',
  dir: 'rtl',
})

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const i18n = useMemo(() => createI18n({ locale }), [locale])
  const value = useMemo(() => ({ locale, dir: dir(locale) }), [locale])
  return (
    <LocaleContext.Provider value={value}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </LocaleContext.Provider>
  )
}

/** The page's locale and text direction. */
export function useLocale() {
  return useContext(LocaleContext)
}
