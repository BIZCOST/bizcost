'use client'

import { createApiClient, createQueryClient, TRPCProvider, useTRPC } from '@bizcost/app-core'
import { API_MAX_BATCH_SIZE, type BusinessContextDto, type MeDto } from '@bizcost/contracts'
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import { useState, type ReactNode } from 'react'

// tRPC + TanStack Query for signed-in pages (docs/ARCHITECTURE.md §Data fetching): same-origin
// /api/trpc with the session cookies. One QueryClient per mount; sign-out reloads the page, which
// drops it. The layout passes `me` from the server so the first render needs no request.

function SeedMe({ me, children }: { me: MeDto; children: ReactNode }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  useState(() => queryClient.setQueryData(trpc.me.queryKey(), me))
  return children
}

export function ApiProvider({ me, children }: { me: MeDto; children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)
  const [trpcClient] = useState(() =>
    createApiClient([httpBatchLink({ url: '/api/trpc', maxItems: API_MAX_BATCH_SIZE })]),
  )
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <SeedMe me={me}>{children}</SeedMe>
      </TRPCProvider>
    </QueryClientProvider>
  )
}

function SeedBusiness({
  me,
  context,
  children,
}: {
  me: MeDto
  context: BusinessContextDto
  children: ReactNode
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  useState(() => {
    queryClient.setQueryData(trpc.me.queryKey(), me)
    queryClient.setQueryData(trpc.business.context.queryKey(), context)
  })
  return children
}

/**
 * The API inside one business (`/b/[businessId]`): every request names it in `x-business-id`, and
 * the business gets its own QueryClient, so no cached data or in-flight query crosses businesses.
 * Mount it with `key={businessId}`. The layout passes `me` and `business.context` from the server.
 */
export function BusinessApiProvider({
  businessId,
  me,
  context,
  children,
}: {
  businessId: string
  me: MeDto
  context: BusinessContextDto
  children: ReactNode
}) {
  const [queryClient] = useState(createQueryClient)
  const [trpcClient] = useState(() =>
    createApiClient([
      httpBatchLink({
        url: '/api/trpc',
        maxItems: API_MAX_BATCH_SIZE,
        headers: { 'x-business-id': businessId },
      }),
    ]),
  )
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <SeedBusiness me={me} context={context}>
          {children}
        </SeedBusiness>
      </TRPCProvider>
    </QueryClientProvider>
  )
}

/** `business.context` of the business the page is in (inside BusinessApiProvider). */
export function useBusinessContext() {
  const trpc = useTRPC()
  return useQuery(trpc.business.context.queryOptions())
}
