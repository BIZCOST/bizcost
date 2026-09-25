'use client'

import { useMe, useTRPC } from '@bizcost/app-core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

/**
 * Remembers the business the user opened (account.setLastBusiness), so `/` and the next sign-in
 * come back to it. A convenience: a failure changes nothing on the page.
 */
export function RememberBusiness({ businessId }: { businessId: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: me } = useMe()
  const { mutate } = useMutation(
    trpc.account.setLastBusiness.mutationOptions({
      onSuccess: (profile) => {
        queryClient.setQueryData(trpc.me.queryKey(), (old) => (old ? { ...old, profile } : old))
      },
    }),
  )
  const last = me?.profile.lastBusinessId
  useEffect(() => {
    if (last !== undefined && last !== businessId) mutate({ businessId })
  }, [businessId, last, mutate])
  return null
}
