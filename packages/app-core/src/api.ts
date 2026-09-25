import type { AppRouter } from '@bizcost/api'
import { isAppErrorCode, type AppErrorCode } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { QueryClient, useQuery } from '@tanstack/react-query'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'

// tRPC + TanStack Query, configured once for both apps (docs/ARCHITECTURE.md §Data fetching). Each app
// passes its own links: web httpBatchStreamLink/httpBatchLink to /api/trpc (cookies), mobile
// httpBatchLink with the Bearer token. Set the batch link's `maxItems` to API_MAX_BATCH_SIZE.

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

export function createApiClient(links: TRPCLink<AppRouter>[]) {
  return createTRPCClient<AppRouter>({ links })
}
export type ApiClient = ReturnType<typeof createApiClient>

export const API_STALE_TIME_MS = 30_000

/** App errors worth retrying: the server failed, not the request. */
const RETRYABLE: ReadonlySet<AppErrorCode> = new Set(['internal'])
const MAX_RETRIES = 2

/** The app error code of a tRPC client error (`error.data.appCode`), if the server sent one. */
export function apiErrorCode(error: unknown): AppErrorCode | undefined {
  if (!(error instanceof TRPCClientError)) return undefined
  const data: unknown = error.data
  const appCode =
    typeof data === 'object' && data !== null && 'appCode' in data ? data.appCode : undefined
  return isAppErrorCode(appCode) ? appCode : undefined
}

/**
 * The i18n key to show for a failed API call: the server's `errors.<appCode>`, `errors.network`
 * when the request never got an answer, else `errors.internal`. Server text is never shown.
 */
export function apiErrorKey(error: unknown): I18nKey {
  const code = apiErrorCode(error)
  if (code) return `errors.${code}`
  if (error instanceof TRPCClientError && error.cause instanceof TypeError) return 'errors.network'
  return 'errors.internal'
}

export function shouldRetry(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error)
  return failureCount < MAX_RETRIES && (code === undefined || RETRYABLE.has(code))
}

/** A fresh QueryClient: one per business (key the provider by businessId); sign-out drops it. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: API_STALE_TIME_MS, retry: shouldRetry },
      mutations: { retry: false },
    },
  })
}

/** The signed-in user's profile and businesses (`me`). */
export function useMe() {
  const trpc = useTRPC()
  return useQuery(trpc.me.queryOptions())
}
