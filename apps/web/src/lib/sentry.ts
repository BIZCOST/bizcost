import type { Breadcrumb, ErrorEvent, NodeOptions } from '@sentry/nextjs'

// Telemetry never carries business secrets (docs/ARCHITECTURE.md §Secrets & server-only code): request
// bodies, cookies and query strings (tRPC GET inputs) are dropped, and any key that looks like cost,
// profit, margin, price or pay data, or like a credential, is replaced before an event leaves.

const SENSITIVE_KEY =
  /cost|profit|margin|price|salary|wage|payroll|password|secret|token|authorization|cookie|api[-_]?key/i

const REDACTED = '[redacted]'
const MAX_DEPTH = 8

/** A copy of `value` with every sensitive key's value replaced, at any depth. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : scrub(item, depth + 1),
      ]),
    )
  }
  return value
}

function withoutQuery(url: string | undefined): string | undefined {
  return url?.split('?')[0]
}

// Drizzle's "Failed query: <sql>\nparams: <values>" carries the bound values (amounts, names). Sentry
// also records an error's causes, so the database error of a failed procedure reaches this text.
const QUERY_PARAMS = /\bparams:[\s\S]*$/

export function scrubMessage(message: string | undefined): string | undefined {
  return message?.replace(QUERY_PARAMS, 'params: [redacted]')
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { ...event }
  if (event.message) scrubbed.message = scrubMessage(event.message)
  if (event.exception?.values) {
    scrubbed.exception = {
      ...event.exception,
      values: event.exception.values.map((exception) => ({
        ...exception,
        value: scrubMessage(exception.value),
      })),
    }
  }
  if (event.request) {
    // Bodies, cookies and query strings are dropped entirely (not copied).
    const { url, method, headers } = event.request
    scrubbed.request = {
      url: withoutQuery(url),
      method,
      headers: scrub(headers) as Record<string, string> | undefined,
    }
  }
  if (event.extra) scrubbed.extra = scrub(event.extra) as ErrorEvent['extra']
  if (event.contexts) scrubbed.contexts = scrub(event.contexts) as ErrorEvent['contexts']
  if (event.tags) scrubbed.tags = scrub(event.tags) as ErrorEvent['tags']
  if (event.user) scrubbed.user = { id: event.user.id }
  if (event.breadcrumbs) scrubbed.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb)
  return scrubbed
}

/**
 * Breadcrumb data is scrubbed like event data, and messages like exception messages. Console
 * breadcrumbs lose their raw `arguments` (the logged values, e.g. a failed query's params).
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (!breadcrumb.data && breadcrumb.message === undefined) return breadcrumb
  const scrubbed: Breadcrumb = { ...breadcrumb }
  if (breadcrumb.message !== undefined) scrubbed.message = scrubMessage(breadcrumb.message)
  if (breadcrumb.data) {
    const kept = Object.entries(breadcrumb.data).filter(
      ([key]) => breadcrumb.category !== 'console' || key !== 'arguments',
    )
    const data = scrub(Object.fromEntries(kept)) as Record<string, unknown>
    if (typeof data.url === 'string') data.url = withoutQuery(data.url)
    scrubbed.data = data
  }
  return scrubbed
}

/** Server-side Sentry options; Sentry is initialised only when SENTRY_DSN is set. */
export function sentryOptions(dsn: string): NodeOptions {
  return {
    dsn,
    tracesSampleRate: 0,
    // Collect as little as possible; beforeSend scrubs whatever still gets through.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent', 'x-app-version'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      queues: false,
    },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  }
}

/** "Name: message" of an error and its causes, with bound query values removed. */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    parts.push(`${current.name}: ${scrubMessage(current.message) ?? ''}`)
    current = current.cause
  }
  return parts.length > 0 ? parts.join(' <- ') : 'non-error thrown'
}
