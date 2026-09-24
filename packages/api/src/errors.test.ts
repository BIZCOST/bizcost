import { ConflictError } from '@bizcost/db'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, appCodeOf, formatError, sqlStateOf, toAppError } from './errors'

/** A driver error wrapped the way drizzle and tRPC wrap it. */
function dbFailure(code: string, message = 'duplicate key value violates unique constraint "x"') {
  const driver = Object.assign(new Error(message), { code })
  const drizzle = new Error('Failed query: insert into "app"."locations" ...', { cause: driver })
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: drizzle })
}

describe('AppError', () => {
  it.each([
    ['unauthorized', 'UNAUTHORIZED'],
    ['forbidden', 'FORBIDDEN'],
    ['module_disabled', 'FORBIDDEN'],
    ['app_version_unsupported', 'PRECONDITION_FAILED'],
    ['validation', 'BAD_REQUEST'],
    ['conflict', 'CONFLICT'],
    ['internal', 'INTERNAL_SERVER_ERROR'],
  ] as const)('%s uses the tRPC code %s', (appCode, trpcCode) => {
    const error = new AppError(appCode)
    expect(error.code).toBe(trpcCode)
    expect(error.message).toBe(appCode)
    expect(appCodeOf(error)).toBe(appCode)
  })

  it('maps plain tRPC errors by their code', () => {
    expect(appCodeOf(new TRPCError({ code: 'BAD_REQUEST' }))).toBe('validation')
    expect(appCodeOf(new TRPCError({ code: 'NOT_FOUND' }))).toBe('not_found')
    expect(appCodeOf(new TRPCError({ code: 'TIMEOUT' }))).toBe('internal')
  })
})

describe('toAppError', () => {
  it.each([
    ['23505', 'conflict'],
    ['40001', 'conflict'],
    ['23514', 'validation'],
    ['23503', 'validation'],
    ['42501', 'forbidden'],
  ] as const)('maps SQLSTATE %s to %s', (state, appCode) => {
    const mapped = toAppError(dbFailure(state))
    expect(appCodeOf(mapped)).toBe(appCode)
    expect(mapped.message).toBe(appCode)
  })

  it('maps ConflictError from an idempotent create to conflict', () => {
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: new ConflictError() })
    expect(appCodeOf(toAppError(error))).toBe('conflict')
  })

  it('leaves unknown database errors and app errors alone', () => {
    const unknown = dbFailure('42P01', 'relation "nope" does not exist')
    expect(toAppError(unknown)).toBe(unknown)
    const app = new AppError('module_disabled')
    expect(toAppError(app)).toBe(app)
  })

  it('finds the SQLSTATE through the cause chain', () => {
    expect(sqlStateOf(dbFailure('23505'))).toBe('23505')
    expect(sqlStateOf(new Error('x'))).toBeUndefined()
  })
})

describe('formatError', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const shapeOf = (error: TRPCError) => ({
    message: error.message,
    code: -32603,
    data: { code: error.code, httpStatus: 500, path: 'x.y', stack: 'Error: at secret/file.ts:1' },
  })

  it('adds appCode and i18nKey', () => {
    const error = new AppError('module_disabled')
    const formatted = formatError({ shape: shapeOf(error), error })
    expect(formatted.data).toMatchObject({
      appCode: 'module_disabled',
      i18nKey: 'errors.module_disabled',
    })
  })

  it('hides the message and the stack in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const error = dbFailure('42P01', 'relation "app"."secret_costs" does not exist')
    const withSqlMessage = new TRPCError({
      code: error.code,
      message: 'relation "app"."secret_costs"',
    })
    const formatted = formatError({ shape: shapeOf(withSqlMessage), error: withSqlMessage })
    expect(formatted.message).toBe('internal')
    expect(formatted.data).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
      path: 'x.y',
      appCode: 'internal',
      i18nKey: 'errors.internal',
    })
    expect(JSON.stringify(formatted)).not.toMatch(/secret|relation|\.ts/)
  })

  it('keeps the message and stack outside production (local debugging)', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const error = new TRPCError({ code: 'BAD_REQUEST', message: 'bad input' })
    const formatted = formatError({ shape: shapeOf(error), error })
    expect(formatted.message).toBe('bad input')
    expect(formatted.data.stack).toBeDefined()
  })
})
