import { describe, expect, it } from 'vitest'
import { APP_ERROR_CODES, appErrorI18nKey, isAppErrorCode } from './errors'

describe('isAppErrorCode', () => {
  it('accepts exactly the listed codes', () => {
    for (const code of APP_ERROR_CODES) expect(isAppErrorCode(code)).toBe(true)
    for (const value of ['FORBIDDEN', 'errors.forbidden', '', null, 403]) {
      expect(isAppErrorCode(value)).toBe(false)
    }
  })

  it('builds typed i18n keys', () => {
    const key: 'errors.module_disabled' = appErrorI18nKey('module_disabled')
    expect(key).toBe('errors.module_disabled')
  })
})
