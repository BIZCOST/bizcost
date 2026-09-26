'use client'

import { formMessage } from '@bizcost/app-core'
import { hasKey, type I18nKey } from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'

/**
 * Translates a form or flow message (an i18n key from the app-core schemas and flows, or an API
 * error key) into text; limits such as the minimum password length are filled in.
 */
export function useMessage() {
  const { t, i18n } = useTranslation()
  return (message: string | null | undefined, values?: Record<string, unknown>) => {
    const resolved = formMessage(message, (key) => hasKey(i18n, key))
    if (!resolved) return undefined
    return t(resolved.key as I18nKey, { ...resolved.values, ...values }) as string
  }
}

/** Wraps a value (an email, a code) so it reads left to right inside Arabic text. */
export function isolate(value: string): string {
  return `⁨${value}⁩`
}
