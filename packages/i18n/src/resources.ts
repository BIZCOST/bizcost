import type { Locale } from '@bizcost/domain'
import arAccount from '../locales/ar/account.json'
import arAuth from '../locales/ar/auth.json'
import arCommon from '../locales/ar/common.json'
import arErrors from '../locales/ar/errors.json'
import enAccount from '../locales/en/account.json'
import enAuth from '../locales/en/auth.json'
import enCommon from '../locales/en/common.json'
import enErrors from '../locales/en/errors.json'

// Translations: locales/<locale>/<namespace>.json. English is the source language and types every key;
// tests fail when a key, plural form or interpolation variable is missing in either language.
// Keys are written in full as `<namespace>.<path>` (nsSeparator '.'), e.g. `auth.login.title`,
// `errors.internal` (the API's `i18nKey`): i18next reads a first segment that names a namespace as the
// namespace. Unprefixed keys are common keys, so common has no top-level key named like a namespace.
// Use `useTranslation()` without a namespace and full keys (with `useTranslation('auth')`, the
// unprefixed `errors.codeInvalid` would resolve in the errors namespace).

export const NAMESPACES = ['common', 'auth', 'account', 'errors'] as const
export type Namespace = (typeof NAMESPACES)[number]

/** Namespace of keys written without a prefix. */
export const DEFAULT_NAMESPACE = 'common' satisfies Namespace

/** Language used when a key is missing in the requested one (tests keep this from happening). */
export const FALLBACK_LOCALE = 'en' satisfies Locale

/** A namespace's messages: nested objects of strings. */
export interface Messages {
  readonly [key: string]: string | Messages
}

/** The English messages; their shape is the type of every translation key. */
export const en = {
  common: enCommon,
  auth: enAuth,
  account: enAccount,
  errors: enErrors,
} as const
export type SourceMessages = typeof en

export const resources: Readonly<Record<Locale, Readonly<Record<Namespace, Messages>>>> = {
  en,
  ar: { common: arCommon, auth: arAuth, account: arAccount, errors: arErrors },
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

/**
 * Whether `key` (`<namespace>.<path>`, without a plural suffix) has a message in `locale`: a string,
 * or the plural forms of one (`<path>_other`).
 */
export function hasMessage(locale: Locale, key: string): boolean {
  const [namespace = '', ...path] = key.split('.')
  if (!(NAMESPACES as readonly string[]).includes(namespace) || path.length === 0) return false
  let node: string | Messages | undefined = resources[locale][namespace as Namespace]
  const last = path.pop()!
  for (const part of path) {
    if (typeof node !== 'object' || PLURAL_SUFFIX.test(part)) return false
    node = node[part]
  }
  if (typeof node !== 'object') return false
  return typeof node[last] === 'string' || typeof node[`${last}_other`] === 'string'
}
