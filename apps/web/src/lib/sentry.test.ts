import type { ErrorEvent } from '@sentry/nextjs'
import { describe, expect, it } from 'vitest'
import { describeError, scrub, scrubBreadcrumb, scrubEvent, sentryOptions } from './sentry'

describe('scrub', () => {
  it('replaces cost, profit, margin, price and pay keys at any depth', () => {
    expect(
      scrub({
        name: 'Latte',
        unitCost: '6.5',
        costPerUnit: '1',
        profitMargin: '0.6',
        margin: '0.6',
        salePrice: '18',
        lines: [{ supplierPrice: '110', qty: '2' }],
        staff: { baseSalary: '4200', hourlyWage: '20', payrollTotal: '9000' },
      }),
    ).toEqual({
      name: 'Latte',
      unitCost: '[redacted]',
      costPerUnit: '[redacted]',
      profitMargin: '[redacted]',
      margin: '[redacted]',
      salePrice: '[redacted]',
      lines: [{ supplierPrice: '[redacted]', qty: '2' }],
      staff: { baseSalary: '[redacted]', hourlyWage: '[redacted]', payrollTotal: '[redacted]' },
    })
  })

  it('replaces credentials', () => {
    expect(scrub({ Authorization: 'Bearer x', cookie: 'sb=1', accessToken: 't' })).toEqual({
      Authorization: '[redacted]',
      cookie: '[redacted]',
      accessToken: '[redacted]',
    })
  })
})

describe('scrubEvent', () => {
  const event = {
    type: undefined,
    message: 'Failed query: insert into app.locations values ($1)\nparams: 6.5,Latte',
    request: {
      url: 'https://app.example.com/api/trpc/items.list?input=%7B%22sortBy%22%3A%22cost%22%7D',
      method: 'POST',
      data: '{"unitCost":"6.5"}',
      cookies: { 'sb-auth-token': 'secret' },
      query_string: 'input=...',
      headers: { authorization: 'Bearer abc', 'x-request-id': 'r1' },
    },
    exception: {
      values: [
        { type: 'TRPCError', value: 'internal' },
        { type: 'DrizzleQueryError', value: 'Failed query: select 1\nparams: 4200' },
      ],
    },
    extra: { input: { cost: '6.5', name: 'Latte' } },
    user: { id: 'u1', email: 'owner@example.com', ip_address: '1.2.3.4' },
    breadcrumbs: [{ category: 'fetch', data: { url: 'https://x.test/a?price=1', margin: '0.2' } }],
  } as unknown as ErrorEvent

  it('drops request bodies, cookies and query strings, and scrubs headers', () => {
    const { request } = scrubEvent(event)
    expect(request).toEqual({
      url: 'https://app.example.com/api/trpc/items.list',
      method: 'POST',
      headers: { authorization: '[redacted]', 'x-request-id': 'r1' },
    })
  })

  it('removes bound query values from messages and exceptions', () => {
    const scrubbed = scrubEvent(event)
    expect(scrubbed.message).toBe(
      'Failed query: insert into app.locations values ($1)\nparams: [redacted]',
    )
    expect(scrubbed.exception?.values?.map((e) => e.value)).toEqual([
      'internal',
      'Failed query: select 1\nparams: [redacted]',
    ])
  })

  it('scrubs extra data, keeps only the user id and cleans breadcrumbs', () => {
    const scrubbed = scrubEvent(event)
    expect(scrubbed.extra).toEqual({ input: { cost: '[redacted]', name: 'Latte' } })
    expect(scrubbed.user).toEqual({ id: 'u1' })
    expect(scrubbed.breadcrumbs).toEqual([
      { category: 'fetch', data: { url: 'https://x.test/a', margin: '[redacted]' } },
    ])
    expect(JSON.stringify(scrubbed)).not.toMatch(/6\.5|4200|abc|owner@example/)
  })

  it('leaves breadcrumbs without data or message alone', () => {
    const crumb = { category: 'navigation', level: 'info' as const }
    expect(scrubBreadcrumb(crumb)).toBe(crumb)
  })

  it('removes bound query values from console breadcrumbs', () => {
    const logged = 'Failed query: insert into app.items values ($1)\nparams: 6.5,Latte'
    const scrubbed = scrubBreadcrumb({
      category: 'console',
      level: 'error',
      message: logged,
      data: { arguments: [logged], logger: 'console' },
    })
    expect(scrubbed).toEqual({
      category: 'console',
      level: 'error',
      message: 'Failed query: insert into app.items values ($1)\nparams: [redacted]',
      data: { logger: 'console' },
    })
  })
})

describe('sentryOptions', () => {
  it('collects no user info, bodies, cookies, query params, DB data or local variables', () => {
    const options = sentryOptions('https://key@o0.ingest.sentry.io/0')
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    })
    expect(typeof options.beforeSend).toBe('function')
    expect(typeof options.beforeBreadcrumb).toBe('function')
  })
})

describe('describeError', () => {
  it('lists the cause chain without bound query values', () => {
    const driver = new Error('duplicate key value violates unique constraint "x"')
    const query = new Error('Failed query: insert into app.items values ($1)\nparams: 6.5', {
      cause: driver,
    })
    const top = new Error('internal', { cause: query })
    expect(describeError(top)).toBe(
      'Error: internal <- Error: Failed query: insert into app.items values ($1)\nparams: [redacted] <- Error: duplicate key value violates unique constraint "x"',
    )
    expect(describeError('boom')).toBe('non-error thrown')
  })
})
