import type { NAMESPACES, Namespace, SourceMessages } from './resources'

// Typed translation keys. Importing @bizcost/i18n adds this augmentation to the program, so
// `t('auth.login.title')` (i18next / react-i18next) is checked against the English messages.

declare module 'i18next' {
  interface CustomTypeOptions {
    /** Every namespace: `t` accepts `<namespace>.<path>` keys, and common keys without a prefix. */
    defaultNS: typeof NAMESPACES
    nsSeparator: '.'
    resources: SourceMessages
  }
}

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
type WithoutPlural<K extends string> = K extends `${infer Base}_${PluralSuffix}` ? Base : K

type Leaves<T, Prefix extends string> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${WithoutPlural<K>}`
    : Leaves<T[K], `${Prefix}${K}.`>
}[keyof T & string]

/** Every translation key as `<namespace>.<path>`, plural keys without their suffix. */
export type I18nKey = { [N in Namespace]: Leaves<SourceMessages[N], `${N}.`> }[Namespace]
