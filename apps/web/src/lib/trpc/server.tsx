import 'server-only'
import {
  appRouter,
  createCallerFactory,
  createContext,
  createFetchHandler,
  type ApiDeps,
} from '@bizcost/api'
import type { MeDto } from '@bizcost/contracts'
import { createDb } from '@bizcost/db'
import { TRPCError } from '@trpc/server'
import { headers } from 'next/headers'
import { cache } from 'react'
import { serverEnv } from '../env'
import { reportApiError } from '../report-error'

// The API on the server (docs/ARCHITECTURE.md §API & request flow): one set of dependencies (one
// database pool) for the /api/trpc route and for server components, which call procedures through
// createCaller without an HTTP hop. Created on first use, so `next build` needs no environment.

let deps: ApiDeps | undefined

function apiDeps(): ApiDeps {
  if (!deps) {
    const env = serverEnv()
    deps = {
      db: createDb(env.databaseUrl),
      config: {
        supabaseUrl: env.supabaseUrl,
        supabasePublishableKey: env.supabasePublishableKey,
        supabaseSecretKey: env.supabaseSecretKey,
        minSupportedAppVersion: env.minSupportedAppVersion,
        allowedOrigins: env.allowedOrigins,
        version: env.version,
      },
      reportError: reportApiError,
    }
  }
  return deps
}

let handler: ((req: Request) => Promise<Response>) | undefined

/** The fetch handler mounted at /api/trpc. */
export function apiHandler(): (req: Request) => Promise<Response> {
  handler ??= createFetchHandler(apiDeps())
  return handler
}

const createCaller = createCallerFactory(appRouter)

/**
 * A server-side caller for the current request (layouts only), authenticated by the request's session
 * cookies exactly like /api/trpc. proxy.ts has already refreshed the session, and a server component
 * cannot set cookies, so refreshed cookies from this context are dropped.
 */
export const getServerApi = cache(async () => {
  const req = new Request('http://server.internal/api/trpc', { headers: await headers() })
  const ctx = createContext({ req, resHeaders: new Headers(), deps: apiDeps(), router: appRouter })
  return createCaller(ctx)
})

/** `me` for a layout; null when the API does not accept the session (e.g. a deleted user). */
export async function getMe(): Promise<MeDto | null> {
  const api = await getServerApi()
  try {
    return await api.me()
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'UNAUTHORIZED') return null
    throw error
  }
}
