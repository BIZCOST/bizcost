'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessProfileDto } from '@bizcost/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'

/** `business.profile` (settings.business.view); `enabled` false until the section is open. */
export function useProfile(enabled = true) {
  const trpc = useTRPC()
  return useQuery({ ...trpc.business.profile.queryOptions(), enabled })
}

/**
 * Keeps a saved profile in the cache and refreshes what shows it elsewhere: the switcher's business
 * name (`me`) and the capabilities (VAT) in the business context.
 */
export function useProfileSaved() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return (profile: BusinessProfileDto) => {
    queryClient.setQueryData(trpc.business.profile.queryKey(), profile)
    void queryClient.invalidateQueries({ queryKey: trpc.me.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.business.context.queryKey() })
  }
}
