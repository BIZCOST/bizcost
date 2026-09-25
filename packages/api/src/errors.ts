import { appErrorI18nKey, type AppErrorCode, type AppErrorData } from '@bizcost/contracts'
import { ConflictError } from '@bizcost/db'
import { TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server'

// Typed API errors (docs/ARCHITECTURE.md §API & request flow). Every error that leaves the API carries
// an app code and its i18n key; clients translate the key and never show server text.

const TRPC_CODE_OF: Record<AppErrorCode, TRPC_ERROR_CODE_KEY> = {
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  not_found: 'NOT_FOUND',
  conflict: 'CONFLICT',
  validation: 'BAD_REQUEST',
  module_disabled: 'FORBIDDEN',
  app_version_unsupported: 'PRECONDITION_FAILED',
  rate_limited: 'TOO_MANY_REQUESTS',
  sole_owner: 'CONFLICT',
  reauth_required: 'FORBIDDEN',
  internal: 'INTERNAL_SERVER_ERROR',
}

/** A tRPC error with an app code. The message defaults to the code: never put SQL or data in it. */
export class AppError extends TRPCError {
  readonly appCode: AppErrorCode

  constructor(appCode: AppErrorCode, options: { message?: string; cause?: unknown } = {}) {
    super({
      code: TRPC_CODE_OF[appCode],
      message: options.message ?? appCode,
      cause: options.cause,
    })
    this.name = 'AppError'
    this.appCode = appCode
  }
}

// Errors raised by tRPC itself (input parsing, unknown procedure, …) carry only a tRPC code.
const APP_CODE_OF: Partial<Record<TRPC_ERROR_CODE_KEY, AppErrorCode>> = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  PARSE_ERROR: 'validation',
  BAD_REQUEST: 'validation',
  UNPROCESSABLE_CONTENT: 'validation',
  PAYLOAD_TOO_LARGE: 'validation',
  UNSUPPORTED_MEDIA_TYPE: 'validation',
  METHOD_NOT_SUPPORTED: 'validation',
  TOO_MANY_REQUESTS: 'rate_limited',
}

export function appCodeOf(error: TRPCError): AppErrorCode {
  if (error instanceof AppError) return error.appCode
  return APP_CODE_OF[error.code] ?? 'internal'
}

// Postgres SQLSTATEs that are the caller's problem, not a server fault (docs/DATA_MODEL.md §1.2, §4).
const APP_CODE_OF_SQLSTATE: Readonly<Record<string, AppErrorCode>> = {
  '23505': 'conflict', // unique_violation (e.g. a second default location)
  '40001': 'conflict', // serialization_failure (e.g. concurrent owner removal in REPEATABLE READ)
  '40P01': 'conflict', // deadlock_detected
  '23514': 'validation', // check_violation (e.g. the last active owner, a malformed TRN)
  '23503': 'validation', // foreign_key_violation (e.g. a role or location of another business)
  '23502': 'validation', // not_null_violation
  '22P02': 'validation', // invalid_text_representation
  '22001': 'validation', // string_data_right_truncation
  '42501': 'forbidden', // insufficient_privilege (RLS WITH CHECK, a revoked grant)
}

const SQLSTATE = /^[0-9A-Z]{5}$/

/** An error and its causes (drizzle and tRPC wrap driver errors), at most 10 deep. */
function* causeChain(error: unknown): Generator<object> {
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 10; depth++) {
    yield current
    current = 'cause' in current ? current.cause : undefined
  }
}

/** SQLSTATE of the first Postgres error in the cause chain. */
export function sqlStateOf(error: unknown): string | undefined {
  for (const current of causeChain(error)) {
    if ('code' in current && typeof current.code === 'string' && SQLSTATE.test(current.code)) {
      return current.code
    }
  }
  return undefined
}

function hasConflictError(error: unknown): boolean {
  for (const current of causeChain(error)) if (current instanceof ConflictError) return true
  return false
}

/**
 * Turns database failures inside a procedure into typed app errors, keeping the original as `cause`
 * (for logs only; it never reaches the client). Other errors are returned unchanged.
 */
export function toAppError(error: TRPCError): TRPCError {
  if (error instanceof AppError) return error
  if (hasConflictError(error)) return new AppError('conflict', { cause: error })
  const state = sqlStateOf(error)
  const appCode = state === undefined ? undefined : APP_CODE_OF_SQLSTATE[state]
  return appCode === undefined ? error : new AppError(appCode, { cause: error })
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

export interface AppErrorShapeData extends AppErrorData {
  code: TRPC_ERROR_CODE_KEY
  httpStatus: number
  path?: string
  stack?: string
}

export interface AppErrorShape {
  message: string
  code: number
  data: AppErrorShapeData
}

interface DefaultErrorShape {
  message: string
  code: number
  data: { code: TRPC_ERROR_CODE_KEY; httpStatus: number; path?: string; stack?: string }
}

/**
 * tRPC errorFormatter: adds `appCode` and `i18nKey`. In production the message is the app code and
 * there is no stack, so no SQL text, data value or file path can leak (unexpected errors are reported
 * through `onError` instead).
 */
export function formatError({
  shape,
  error,
}: {
  shape: DefaultErrorShape
  error: TRPCError
}): AppErrorShape {
  const appCode = appCodeOf(error)
  const production = isProduction()
  const data: AppErrorShapeData = {
    code: shape.data.code,
    httpStatus: shape.data.httpStatus,
    appCode,
    i18nKey: appErrorI18nKey(appCode),
  }
  if (shape.data.path !== undefined) data.path = shape.data.path
  if (!production && shape.data.stack !== undefined) data.stack = shape.data.stack
  return { message: production ? appCode : shape.message, code: shape.code, data }
}
