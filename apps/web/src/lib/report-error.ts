import 'server-only'
import * as Sentry from '@sentry/nextjs'
import { describeError } from './sentry'

/**
 * Unexpected API errors: to Sentry (a no-op without SENTRY_DSN; events are scrubbed in beforeSend) and
 * to the function log, with the request id so the two can be matched. The log line never carries
 * bound query values.
 */
export function reportApiError(error: unknown, info: { requestId?: string; path?: string }): void {
  Sentry.captureException(error, { tags: { requestId: info.requestId, path: info.path } })
  console.error(
    `[api] internal error request=${info.requestId ?? '-'} path=${info.path ?? '-'}: ${describeError(error)}`,
  )
}
