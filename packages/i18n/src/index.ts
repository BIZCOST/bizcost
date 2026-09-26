export { isLocale, LOCALES, type Locale } from '@bizcost/domain'
export { createI18n, type CreateI18nOptions } from './create'
export {
  currencyDigits,
  formatCurrency,
  formatDate,
  formatDecimal,
  formatList,
  formatNumber,
} from './format'
export {
  addMessages,
  createI18nInstance,
  hasKey,
  type CreateI18nInstanceOptions,
  type I18n,
} from './instance'
export {
  DEFAULT_LOCALE,
  dir,
  intlLocale,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  negotiateLocale,
  resolveLocale,
  type Direction,
  type LocaleSources,
} from './locale'
export {
  DEFAULT_NAMESPACE,
  FALLBACK_LOCALE,
  isNamespace,
  NAMESPACES,
  type MessageBundle,
  type Messages,
  type Namespace,
} from './namespaces'
export {
  hasMessage,
  pickMessages,
  resources,
  type MessageSpec,
  type SourceMessages,
} from './resources'
export { terminologyKey } from './terminology'
export type { I18nKey } from './types'
