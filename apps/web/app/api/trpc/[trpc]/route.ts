import { createFetchHandler } from '@bizcost/api'
import { createDb } from '@bizcost/db'
import { serverEnv } from '../../../../src/lib/env'
import { reportApiError } from '../../../../src/lib/report-error'

// The only API entry of the web app (docs/ARCHITECTURE.md §Repo structure): tRPC over fetch.
// Created on the first request so `next build` needs no environment.

let handler: ((req: Request) => Promise<Response>) | undefined

function apiHandler(): (req: Request) => Promise<Response> {
  if (!handler) {
    const env = serverEnv()
    handler = createFetchHandler({
      db: createDb(env.databaseUrl),
      config: {
        supabaseUrl: env.supabaseUrl,
        supabasePublishableKey: env.supabasePublishableKey,
        minSupportedAppVersion: env.minSupportedAppVersion,
        allowedOrigins: env.allowedOrigins,
        version: env.version,
      },
      reportError: reportApiError,
    })
  }
  return handler
}

function handle(req: Request): Promise<Response> {
  return apiHandler()(req)
}

export { handle as GET, handle as POST }
