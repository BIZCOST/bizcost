import { TRPCClientError } from '@trpc/client'
import { describe, expect, it } from 'vitest'
import {
  apiErrorKey,
  createQueryClient,
  isAccessChange,
  shouldRetry,
  API_STALE_TIME_MS,
} from './api'

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

describe('access changes', () => {
  it('are the refusals that mean the cached access is stale', () => {
    for (const code of ['forbidden', 'capability_disabled', 'module_disabled']) {
      expect(isAccessChange(serverError(code)), code).toBe(true)
    }
    for (const code of ['validation', 'conflict', 'internal', 'unauthorized']) {
      expect(isAccessChange(serverError(code)), code).toBe(false)
    }
    expect(isAccessChange(new Error('boom'))).toBe(false)
  })

  it('call onAccessChange for a refused query or mutation, and nothing else', async () => {
    let calls = 0
    const client = createQueryClient({ onAccessChange: () => calls++ })
    await client
      .fetchQuery({ queryKey: ['a'], queryFn: () => Promise.reject(serverError('forbidden')) })
      .catch(() => {})
    await client
      .fetchQuery({ queryKey: ['b'], queryFn: () => Promise.reject(serverError('validation')) })
      .catch(() => {})
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(serverError('capability_disabled')),
    })
    await mutation.execute(undefined).catch(() => {})
    expect(calls).toBe(2)
  })
})

describe('mutation success', () => {
  it('calls onMutationSuccess with the key after each successful mutation only', async () => {
    const keys: unknown[] = []
    const client = createQueryClient({ onMutationSuccess: (key) => keys.push(key) })
    const build = (fn: () => Promise<unknown>) =>
      client.getMutationCache().build(client, { mutationKey: [['a', 'b']], mutationFn: fn })
    await build(() => Promise.resolve('ok')).execute(undefined)
    await build(() => Promise.reject(serverError('validation')))
      .execute(undefined)
      .catch(() => {})
    await client.fetchQuery({ queryKey: ['q'], queryFn: () => Promise.resolve(1) })
    expect(keys).toEqual([[['a', 'b']]])
  })
})
