import type { Locale } from '@bizcost/domain'

// The translation namespaces and the shape of their messages, without the messages themselves: code
// that runs in the browser imports this, never ./resources (which bundles every JSON file of both
// languages). The browser gets its messages from the server, per locale and route (./pick.ts).

export const NAMESPACES = [
  'common',
  'auth',
  'account',
  'errors',
  'setup',
  'modules',
  'emails',
  'settings',
  'dashboard',
] as const
export type Namespace = (typeof NAMESPACES)[number]

/** Namespace of keys written without a prefix. */
export const DEFAULT_NAMESPACE = 'common' satisfies Namespace

/** Language used when a key is missing in the requested one (tests keep this from happening). */
export const FALLBACK_LOCALE = 'en' satisfies Locale

/** A namespace's messages: nested objects of strings. */
export interface Messages {
  readonly [key: string]: string | Messages
}

/** Messages of one language, by namespace (all or some of them, whole or in part). */
export type MessageBundle = Readonly<Partial<Record<Namespace, Messages>>>

export function isNamespace(value: unknown): value is Namespace {
  return (NAMESPACES as readonly unknown[]).includes(value)
}
