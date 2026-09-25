import { TRPCClientError } from '@trpc/client'
import { describe, expect, it } from 'vitest'
import { apiErrorKey, createQueryClient, shouldRetry, API_STALE_TIME_MS } from './api'

function serverError(appCode: string) {
  return new TRPCClientError('x', {
    result: {
      error: {
        code: -32603,
        message: 'x',
        data: { code: 'X', httpStatus: 400, appCode, i18nKey: `errors.${appCode}` },
      },
    },
  })
}

describe('apiErrorKey', () => {
  it('uses the app code the server sent, never its message', () => {
    expect(apiErrorKey(serverError('forbidden'))).toBe('errors.forbidden')
    expect(apiErrorKey(serverError('validation'))).toBe('errors.validation')
  })

  it('maps a request that got no answer to errors.network', () => {
    const error = TRPCClientError.from(new TypeError('Failed to fetch'))
    expect(apiErrorKey(error)).toBe('errors.network')
  })

  it('maps anything else to errors.internal', () => {
    expect(apiErrorKey(serverError('made_up'))).toBe('errors.internal')
    expect(apiErrorKey(new Error('boom'))).toBe('errors.internal')
    expect(apiErrorKey(undefined)).toBe('errors.internal')
  })
})

describe('query defaults', () => {
  it('retry server failures twice and never a refused request', () => {
    expect(shouldRetry(0, serverError('internal'))).toBe(true)
    expect(shouldRetry(1, TRPCClientError.from(new TypeError('Failed to fetch')))).toBe(true)
    expect(shouldRetry(2, serverError('internal'))).toBe(false)
    for (const code of ['unauthorized', 'forbidden', 'validation', 'rate_limited']) {
      expect(shouldRetry(0, serverError(code))).toBe(false)
    }
  })

  it('create a new client each time with the shared stale time', () => {
    const a = createQueryClient()
    expect(a).not.toBe(createQueryClient())
    expect(a.getDefaultOptions().queries?.staleTime).toBe(API_STALE_TIME_MS)
  })
})
