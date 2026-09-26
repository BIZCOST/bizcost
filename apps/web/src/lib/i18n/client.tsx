'use client'

import {
  addMessages,
  createI18nInstance,
  dir,
  hasKey,
  terminologyKey,
  type Direction,
  type I18nKey,
  type Locale,
  type MessageBundle,
} from '@bizcost/i18n'
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { TerminologyProfile } from '@bizcost/domain'

// The browser side of i18n (D-092). The browser never bundles translations: the server passes the
// messages of the page's language only, and only the namespaces its route needs. The root layout
// passes `common` and `errors` to I18nProvider; layouts and pages below add theirs with <Messages>
// (./messages.tsx), which renders AddMessages. A language switch renders the page again on the server
// (router.refresh()), so the new locale arrives with its own messages and a NEW instance is created:
// no reload, and never two languages in one instance.

const LocaleContext = createContext<{ locale: Locale; dir: Direction }>({
  locale: 'ar',
  dir: 'rtl',
})

/** A message to show once the page has switched to the new language (see I18nProvider). */
let afterSwitch: I18nKey | null = null

/** Shows `key` as a success toast in the new language, once the language switch is done. */
export function toastAfterLanguageSwitch(key: I18nKey): void {
  afterSwitch = key
}

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale
  messages: MessageBundle
  children: ReactNode
}) {
  // One instance per language: the root layout passes the same namespaces on every page, so only a
  // new locale needs a new instance (with the messages that came with it).
  const i18n = useMemo(
    () => createI18nInstance({ locale, messages: { [locale]: messages } }),
    [locale],
  )
  const value = useMemo(() => ({ locale, dir: dir(locale) }), [locale])
  useEffect(() => {
    if (!afterSwitch) return
    toast.success(i18n.t(afterSwitch))
    afterSwitch = null
  }, [i18n])
  return (
    <LocaleContext.Provider value={value}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </LocaleContext.Provider>
  )
}

/**
 * Adds the messages a layout or page needs to the page's instance, before its children render (the
 * server component <Messages> renders it). Adding what the instance already holds changes nothing.
 * Messages in another language come from a layout the router kept from before a language change (a
 * link prefetched in the old language): the page is rendered again on the server instead, and nothing
 * is shown until then (never untranslated keys).
 */
export function AddMessages({
  locale,
  messages,
  children,
}: {
  locale: Locale
  messages: MessageBundle
  children: ReactNode
}) {
  const { i18n } = useTranslation()
  const router = useRouter()
  const stale = i18n.language !== locale
  const added = useRef<{ i18n: unknown; messages: MessageBundle } | null>(null)
  if (!stale && (added.current?.i18n !== i18n || added.current.messages !== messages)) {
    // Idempotent and synchronous, so it may run while rendering: the children need the messages now.
    addMessages(i18n, locale, messages)
    added.current = { i18n, messages }
  }
  useEffect(() => {
    if (stale) router.refresh()
  }, [stale, router])
  return stale ? null : children
}

/** The page's locale and text direction. */
export function useLocale() {
  return useContext(LocaleContext)
}

/**
 * `t` in a business's wording: the key's terminology overlay for `profile` when the page has one
 * (`modules.materials.name` → "Ingredients" for food), else the key's own message.
 */
export function useTerminology() {
  const { t, i18n } = useTranslation()
  return (key: I18nKey, profile: TerminologyProfile | null | undefined): string =>
    t(terminologyKey(key, profile, (k) => hasKey(i18n, k)))
}
