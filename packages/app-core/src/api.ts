import type { AppRouter } from '@bizcost/api'
import { isAppErrorCode, type AppErrorCode } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { MutationCache, QueryCache, QueryClient, useQuery } from '@tanstack/react-query'
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
 * The names a refusal is about (`error.data.names`: UNIT_IN_USE names the products whose recipes
 * use the unit), when the server sent any; else empty.
 */
export function apiErrorNames(error: unknown): string[] {
  if (!(error instanceof TRPCClientError)) return []
  const data: unknown = error.data
  const names =
    typeof data === 'object' && data !== null && 'names' in data ? data.names : undefined
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === 'string')
    : []
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

/**
 * Answers that mean the caller's access changed since the page loaded it (a new role, a switched-off
 * capability or module, a removed membership): the cached `me` and business context are stale.
 */
const ACCESS_CHANGED: ReadonlySet<AppErrorCode> = new Set([
  'forbidden',
  'capability_disabled',
  'module_disabled',
])

/** Whether a failed API call means the caller's access changed (refresh `me` and the context). */
export function isAccessChange(error: unknown): boolean {
  const code = apiErrorCode(error)
  return code !== undefined && ACCESS_CHANGED.has(code)
}

/** The caller's permissions version in the business: sent by every business procedure. */
export const PERMISSIONS_VERSION_HEADER = 'x-permissions-version'

/**
 * A fetch for the business's API client that watches `x-permissions-version`: when an answer carries a
 * newer version than the page has seen (a role or its permissions changed while the page is open),
 * `onNewer` runs once, e.g. to refetch `me` and `business.context`. It catches what no refusal shows:
 * a role that now grants more is refused nothing (docs/ARCHITECTURE.md §Data fetching, stale
 * permissions). `initial` is the version of the business context the page loaded; an answer with the
 * same or an older version (a request that started before the change) changes nothing, so the
 * refetched context itself never triggers another refetch.
 */
export function watchPermissionsVersion(
  initial: number,
  onNewer: () => void,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  let seen = initial
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const version = Number(response.headers.get(PERMISSIONS_VERSION_HEADER) ?? Number.NaN)
    if (Number.isSafeInteger(version) && version > seen) {
      seen = version
      onNewer()
    }
    return response
  }
}

export interface QueryClientOptions {
  /**
   * Called when a query or mutation is refused because the caller's access changed
   * (isAccessChange), e.g. to refetch `me` and `business.context` (docs/ARCHITECTURE.md §Data
   * fetching: stale permissions refresh after FORBIDDEN).
   */
  onAccessChange?: () => void
  /**
   * Called after every successful mutation with its key (tRPC's: `[['business', 'updateProfile']]`),
   * e.g. to refresh what summarizes the business's data (the Dashboard's checklist), wherever the
   * change was made.
   */
  onMutationSuccess?: (mutationKey: readonly unknown[] | undefined) => void
}

/** A fresh QueryClient: one per business (key the provider by businessId); sign-out drops it. */
export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const { onAccessChange, onMutationSuccess } = options
  const onError = (error: unknown) => {
    if (onAccessChange && isAccessChange(error)) onAccessChange()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({
      onError,
      ...(onMutationSuccess
        ? {
            onSuccess: (_data, _variables, _context, mutation) =>
              onMutationSuccess(mutation.options.mutationKey),
          }
        : {}),
    }),
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
