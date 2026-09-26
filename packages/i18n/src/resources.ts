import type { Locale } from '@bizcost/domain'
import arAccount from '../locales/ar/account.json'
import arAuth from '../locales/ar/auth.json'
import arCommon from '../locales/ar/common.json'
import arDashboard from '../locales/ar/dashboard.json'
import arEmails from '../locales/ar/emails.json'
import arErrors from '../locales/ar/errors.json'
import arModules from '../locales/ar/modules.json'
import arSettings from '../locales/ar/settings.json'
import arSetup from '../locales/ar/setup.json'
import enAccount from '../locales/en/account.json'
import enAuth from '../locales/en/auth.json'
import enCommon from '../locales/en/common.json'
import enDashboard from '../locales/en/dashboard.json'
import enEmails from '../locales/en/emails.json'
import enErrors from '../locales/en/errors.json'
import enModules from '../locales/en/modules.json'
import enSettings from '../locales/en/settings.json'
import enSetup from '../locales/en/setup.json'
import { NAMESPACES, type MessageBundle, type Messages, type Namespace } from './namespaces'

// Translations: locales/<locale>/<namespace>.json. English is the source language and types every key;
// tests fail when a key, plural form or interpolation variable is missing in either language.
// Keys are written in full as `<namespace>.<path>` (nsSeparator '.'), e.g. `auth.login.title`,
// `errors.internal` (the API's `i18nKey`): i18next reads a first segment that names a namespace as the
// namespace. Unprefixed keys are common keys, so common has no top-level key named like a namespace.
// Use `useTranslation()` without a namespace and full keys (with `useTranslation('auth')`, the
// unprefixed `errors.codeInvalid` would resolve in the errors namespace).
//
// This module holds every message of both languages. The server and the API use it; code that runs in
// the browser never imports it: the browser gets the pickMessages() output of its page from the server
// (D-069, D-092).

export {
  DEFAULT_NAMESPACE,
  FALLBACK_LOCALE,
  NAMESPACES,
  type Messages,
  type Namespace,
} from './namespaces'

/** The English messages; their shape is the type of every translation key. */
export const en = {
  common: enCommon,
  auth: enAuth,
  account: enAccount,
  errors: enErrors,
  setup: enSetup,
  modules: enModules,
  emails: enEmails,
  settings: enSettings,
  dashboard: enDashboard,
} as const
export type SourceMessages = typeof en

export const resources: Readonly<Record<Locale, Readonly<Record<Namespace, Messages>>>> = {
  en,
  ar: {
    common: arCommon,
    auth: arAuth,
    account: arAccount,
    errors: arErrors,
    setup: arSetup,
    modules: arModules,
    emails: arEmails,
    settings: arSettings,
    dashboard: arDashboard,
  },
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

/**
 * What a page needs of a namespace: all of it, or some of its parts. A part is a dotted path inside
 * the namespace (e.g. `cap` or `review.groups.about`) that names a branch, or a message together with
 * its plural forms and terminology overlays (`about_one`, `about_food`…).
 */
export type MessageSpec =
  Namespace | { readonly namespace: Namespace; readonly paths: readonly string[] }

function isBranch(value: string | Messages | undefined): value is Messages {
  return typeof value === 'object'
}

/** The part of `messages` at `path`, rebuilt from the root. */
function pickPath(messages: Messages, path: readonly string[]): Messages {
  const [head, ...rest] = path
  if (head === undefined) return messages
  if (rest.length === 0) {
    return Object.fromEntries(
      Object.entries(messages).filter(([key]) => key === head || key.startsWith(`${head}_`)),
    )
  }
  const child = messages[head]
  return isBranch(child) ? { [head]: pickPath(child, rest) } : {}
}

function merge(a: Messages, b: Messages): Messages {
  const out: Record<string, string | Messages> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const current = out[key]
    out[key] = isBranch(current) && isBranch(value) ? merge(current, value) : value
  }
  return out
}

/**
 * The messages of `locale` that a page needs (docs/ARCHITECTURE.md §i18n & RTL). The server passes
 * them to the browser, which so holds only the page's language and namespaces. A path that names
 * nothing adds nothing.
 */
export function pickMessages(locale: Locale, specs: readonly MessageSpec[]): MessageBundle {
  const out: Partial<Record<Namespace, Messages>> = {}
  for (const spec of specs) {
    const namespace = typeof spec === 'string' ? spec : spec.namespace
    const all = resources[locale][namespace]
    const part =
      typeof spec === 'string'
        ? all
        : spec.paths.reduce<Messages>((acc, path) => merge(acc, pickPath(all, path.split('.'))), {})
    const current = out[namespace]
    out[namespace] = current ? merge(current, part) : part
  }
  return out
}
