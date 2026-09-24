import * as Sentry from '@sentry/nextjs'

// Next.js instrumentation hook. Sentry runs only when SENTRY_DSN is set, with telemetry scrubbing
// (src/lib/sentry.ts); an invalid DSN only disables Sentry. There is no client-side Sentry yet: Step 2
// ships no pages.
export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim()
  if (!dsn || process.env.NEXT_RUNTIME !== 'nodejs') return
  const { sentryOptions } = await import('./src/lib/sentry')
  Sentry.init(sentryOptions(dsn))
}

export const onRequestError = Sentry.captureRequestError
