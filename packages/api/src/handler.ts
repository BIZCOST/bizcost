import { API_MAX_BATCH_SIZE } from '@bizcost/contracts'
import type { AnyRouter } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { createContext } from './context'
import type { ApiDeps } from './deps'
import { appCodeOf } from './errors'
import { appRouter } from './routers'

export interface FetchHandlerOptions {
  /** Path the router is mounted at (default /api/trpc). */
  readonly endpoint?: string
  /** Router to serve (default appRouter; tests serve extra test-only routers). */
  readonly router?: AnyRouter
}

/**
 * The API as a fetch handler (Request → Response): mounted by apps/web at /api/trpc, and portable to
 * any fetch runtime (docs/ARCHITECTURE.md §Overview, exit paths).
 */
export function createFetchHandler(
  deps: ApiDeps,
  options: FetchHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const router = options.router ?? appRouter
  const endpoint = options.endpoint ?? '/api/trpc'
  return (req) =>
    fetchRequestHandler({
      endpoint,
      req,
      router,
      // One request may not queue an unbounded number of calls on the (small) connection pool.
      maxBatchSize: API_MAX_BATCH_SIZE,
      createContext: ({ req, resHeaders }) => createContext({ req, resHeaders, deps, router }),
      onError: ({ error, ctx, path }) => {
        if (appCodeOf(error) === 'internal') {
          deps.reportError?.(error, { requestId: ctx?.requestId, path })
        }
      },
    })
}
