'use client'

import { createApiClient, createQueryClient, TRPCProvider, useTRPC } from '@bizcost/app-core'
import { API_MAX_BATCH_SIZE, type MeDto } from '@bizcost/contracts'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
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
