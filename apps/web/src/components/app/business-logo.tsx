'use client'

import { useMe, useTRPC } from '@bizcost/app-core'
import { hashKey, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { StoreIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

// A business's logo (D-097): the short-lived signed URL `me` gives each membership, drawn whole
// (object-contain) in a fixed square on white, so nothing moves when it loads; the store mark
// without a logo. A logo that fails to load (its URL expired while the page stayed open) shows the
// store mark and refetches `me`, which brings a new URL; the logo is tried again once `me` has been
// fetched again. One refetch per REFRESH_GAP_MS at most, however many logos fail at once.

const REFRESH_GAP_MS = 30_000
/** When each query (by hash) was last refetched for a failed image, per query client. */
const lastRefresh = new WeakMap<QueryClient, Map<string, number>>()

/**
 * Whether the signed image `url` failed with the data it came from (the query `queryKey`, fetched at
 * `dataUpdatedAt`), and what to do when it fails: refetch that query, which brings a new URL, at most
 * once per REFRESH_GAP_MS; the image is tried again once the query has been fetched again. Also used
 * by the logo preview in Settings (business.profile).
 */
export function useSignedUrlFailure(
  url: string | null,
  queryKey: QueryKey,
  dataUpdatedAt: number,
): { failed: boolean; onError: () => void } {
  const queryClient = useQueryClient()
  const hash = hashKey(queryKey)
  const [failure, setFailure] = useState<{ url: string; at: number } | null>(null)
  const onError = useCallback(() => {
    if (!url) return
    setFailure({ url, at: dataUpdatedAt })
    let refreshed = lastRefresh.get(queryClient)
    if (!refreshed) {
      refreshed = new Map()
      lastRefresh.set(queryClient, refreshed)
    }
    const now = Date.now()
    if (now - (refreshed.get(hash) ?? 0) < REFRESH_GAP_MS) return
    refreshed.set(hash, now)
    void queryClient.invalidateQueries({ predicate: (query) => query.queryHash === hash })
  }, [url, dataUpdatedAt, queryClient, hash])
  return { failed: failure?.url === url && failure.at === dataUpdatedAt, onError }
}

/** Whether `url` failed with the `me` it came from, and what to do when it fails. */
function useLogoFailure(url: string | null): { failed: boolean; onError: () => void } {
  const trpc = useTRPC()
  const { dataUpdatedAt } = useMe()
  return useSignedUrlFailure(url, trpc.me.queryKey(), dataUpdatedAt)
}

export function BusinessLogo({
  url,
  name,
  className,
  iconClassName,
}: {
  /** `logoUrl` of the membership; null shows the store mark. */
  url: string | null
  /** The business's name as the page shows it (businessDisplayName): the picture's alt text. */
  name: string
  /** The square's size and corners (default size-7 rounded-lg); may set its background. */
  className?: string
  iconClassName?: string
}) {
  const { failed, onError } = useLogoFailure(url)
  const image = useRef<HTMLImageElement>(null)
  // An image that failed before the page was hydrated fired its error with nobody listening.
  useEffect(() => {
    const element = image.current
    if (element?.complete && element.naturalWidth === 0) onError()
  }, [onError])
  const shown = url !== null && !failed
  return (
    // The name is always shown beside the logo: the mark is hidden from screen readers, so the name
    // is read once.
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg',
        shown ? 'bg-white ring-1 ring-foreground/10' : 'bg-accent text-primary',
        className,
      )}
    >
      {shown ? (
        // A signed URL of the private bucket: a plain image, not next/image.
        <img
          ref={image}
          src={url}
          alt={name}
          decoding="async"
          draggable={false}
          onError={onError}
          className="size-full object-contain p-0.5"
        />
      ) : (
        <StoreIcon aria-hidden className={cn('size-4', iconClassName)} />
      )}
    </span>
  )
}
