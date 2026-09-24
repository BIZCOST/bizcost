// Typed API errors (docs/ARCHITECTURE.md §API & request flow). The server's error formatter puts the
// code and its i18n key on every error; clients translate the key and never show server text.

export const APP_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'validation',
  'module_disabled',
  'app_version_unsupported',
  'rate_limited',
  'internal',
] as const
export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

export type AppErrorI18nKey = `errors.${AppErrorCode}`

export function appErrorI18nKey<C extends AppErrorCode>(code: C): `errors.${C}` {
  return `errors.${code}`
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (APP_ERROR_CODES as readonly unknown[]).includes(value)
}

/** What the error formatter adds to `error.data`. */
export interface AppErrorData {
  appCode: AppErrorCode
  i18nKey: AppErrorI18nKey
}
