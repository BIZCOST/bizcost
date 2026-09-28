'use client'

import type { I18nKey } from '@bizcost/i18n'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisVerticalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { LoadError } from '@/components/states/query-state'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// The frame of a catalog list (Materials, Products & Services; M2 Step 2): the page's title and its
// "Add" button, a search in the names and which records to show (in use, archived, all), kept in the
// address so a reload or a shared link shows the same list, the rows, and a page of more at the end.
// A first-time empty list says in plain words what to add first, and is all the page shows.

export const LIST_STATUSES = ['active', 'archived', 'all'] as const
export type ListStatus = (typeof LIST_STATUSES)[number]

const SEARCH_DELAY_MS = 300

function isStatus(value: string | null): value is ListStatus {
  return (LIST_STATUSES as readonly (string | null)[]).includes(value)
}

/** The list's search (`?q=`) and status (`?status=`), read from and written to the address. */
export function useListParams() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const statusParam = params.get('status')
  const status: ListStatus = isStatus(statusParam) ? statusParam : 'active'
  const search = (params.get('q') ?? '').trim()
  const set = (next: { search?: string; status?: ListStatus }) => {
    const query = new URLSearchParams(params.toString())
    if (next.search !== undefined) {
      if (next.search.trim()) query.set('q', next.search.trim())
      else query.delete('q')
    }
    if (next.status !== undefined) {
      if (next.status === 'active') query.delete('status')
      else query.set('status', next.status)
    }
    const text = query.toString()
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
  }
  return { search, status, set }
}

/** A list's first page as useInfiniteQuery holds it. */
interface ListPages {
  readonly data?: { readonly pages: readonly { readonly items: readonly unknown[] }[] }
  readonly isSuccess: boolean
  readonly isPlaceholderData: boolean
}

/**
 * Whether the list shows nothing in use, without a search: the moment to ask whether the business
 * has any record at all (useFirstTime).
 */
export function isNothingInUse(list: ListPages, search: string, status: ListStatus): boolean {
  return (
    !search &&
    status === 'active' &&
    list.isSuccess &&
    !list.isPlaceholderData &&
    (list.data?.pages[0]?.items.length ?? 0) === 0
  )
}

/**
 * Whether the business has none of these records yet, in use or archived (D-132): the page then
 * shows only the first-time card with its one "Add", without the search, the status choice and the
 * header's button. `everything` is one row of the list with every status, asked only while nothing
 * is in use (undefined while it is on its way); until it answers, a page that has shown rows keeps
 * its tools, so archiving the last record does not make them blink.
 */
export function useFirstTime(
  list: ListPages,
  nothingInUse: boolean,
  everything: { readonly items: readonly unknown[] } | undefined,
): boolean {
  const hasRows = (list.data?.pages[0]?.items.length ?? 0) > 0
  const [seenRows, setSeenRows] = useState(hasRows)
  if (hasRows && !seenRows) setSeenRows(true)
  return nothingInUse && (everything ? everything.items.length === 0 : !seenRows)
}

/** The page's heading, what the list is for, and the "Add" button for members who may add. */
export function ListHeader({
  title,
  intro,
  addLabel,
  onAdd,
}: {
  title: string
  intro: string
  addLabel: string | null
  onAdd: () => void
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">{intro}</p>
      </div>
      {addLabel ? (
        <Button size="lg" className="shrink-0" onClick={onAdd}>
          <PlusIcon aria-hidden />
          {addLabel}
        </Button>
      ) : null}
    </header>
  )
}

/** The search box (it searches as you type, a moment after) and the status choice. */
export function ListToolbar({
  search,
  status,
  onChange,
}: {
  search: string
  status: ListStatus
  onChange: (next: { search?: string; status?: ListStatus }) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(search)
  const typed = useRef(search)
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  })
  // The address changed without typing (back, a link): show its search.
  useEffect(() => {
    if (search !== typed.current.trim()) {
      typed.current = search
      setText(search)
    }
  }, [search])
  useEffect(() => {
    if (text.trim() === search) return
    const timer = setTimeout(() => change.current({ search: text }), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, search])
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
      <div role="search" className="relative min-w-0 flex-1">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label={t('catalog.list.searchLabel')}
          placeholder={t('catalog.list.searchPlaceholder')}
          autoComplete="off"
          enterKeyHint="search"
          value={text}
          onChange={(event) => {
            typed.current = event.target.value
            setText(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onChange({ search: text })
          }}
          // Typed text reads in its own direction; the icon, the placeholder and the clear button
          // follow the page's.
          className="ps-9 pe-11 [unicode-bidi:plaintext] [&::-webkit-search-cancel-button]:hidden"
        />
        {text ? (
          <button
            type="button"
            aria-label={t('catalog.list.clearSearch')}
            onClick={() => {
              typed.current = ''
              setText('')
              onChange({ search: '' })
            }}
            className="absolute end-0 top-0 flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
          >
            <XIcon aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
      <fieldset className="flex shrink-0 rounded-lg bg-muted p-1">
        <legend className="sr-only">{t('catalog.list.statusLabel')}</legend>
        {LIST_STATUSES.map((value) => (
          <label key={value} className="relative flex-1 sm:flex-none">
            <input
              type="radio"
              name="catalog-status"
              value={value}
              checked={status === value}
              onChange={() => onChange({ status: value })}
              className="peer sr-only"
            />
            <span
              className={cn(
                'flex h-9 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors',
                'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                'after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""]',
              )}
            >
              {t(`catalog.list.status.${value}`)}
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  )
}

/** Placeholder rows while a list loads; screen readers hear "Loading…" once. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation()
  return (
    <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]">
      <p role="status" className="sr-only">
        {t('status.loading')}
      </p>
      <div aria-hidden className="divide-y">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-4 sm:px-5">
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3.5 w-64 max-w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A list with nothing in it: why, and what to do next. */
export function ListEmpty({
  icon: Icon,
  title,
  body,
  children,
}: {
  icon: LucideIcon
  title: string
  body: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl bg-card px-6 py-12 text-center shadow-sm ring-1 ring-foreground/[0.06] sm:py-14">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-primary">
        <Icon aria-hidden className="size-6" />
      </span>
      <h2 className="mt-5 text-lg font-semibold text-balance">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
        {body}
      </p>
      {children ? <div className="mt-6">{children}</div> : null}
    </div>
  )
}

/**
 * The list's states and rows: loading, failed, empty (a first-time list, a search without matches,
 * nothing archived), then the rows and "Show more" while there are more pages.
 */
export function ListBody<T extends { id: string }>({
  query,
  search,
  status,
  label,
  firstTime,
  renderRow,
}: {
  query: {
    data: { pages: readonly { items: readonly T[] }[] } | undefined
    isPending: boolean
    isError: boolean
    error: unknown
    refetch: () => unknown
    hasNextPage: boolean
    fetchNextPage: () => unknown
    isFetchingNextPage: boolean
  }
  search: string
  status: ListStatus
  /** The list's accessible name (the page's title). */
  label: string
  /** What a first-time empty list shows. */
  firstTime: ReactNode
  renderRow: (item: T) => ReactNode
}) {
  const { t } = useTranslation()
  if (query.isPending) return <ListSkeleton />
  if (query.isError && !query.data) {
    return <LoadError error={query.error} onRetry={() => void query.refetch()} />
  }
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  if (items.length === 0) {
    if (search) {
      return (
        <ListEmpty
          icon={SearchXIcon}
          title={t('catalog.list.noMatches', { search: isolate(search) })}
          body={t(
            status === 'all' ? 'catalog.list.noMatchesHintAll' : 'catalog.list.noMatchesHint',
          )}
        />
      )
    }
    if (status === 'archived') {
      return (
        <ListEmpty
          icon={ArchiveIcon}
          title={t('catalog.list.noArchived')}
          body={t('catalog.list.noArchivedHint')}
        />
      )
    }
    return firstTime
  }
  return (
    <div className="space-y-4">
      <ul
        aria-label={label}
        className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
      >
        {items.map((item) => (
          <li key={item.id}>{renderRow(item)}</li>
        ))}
      </ul>
      {query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.fetchNextPage()} />
      ) : query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? t('status.loading') : t('catalog.list.showMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One row: its icon, name and details. For members who may change it, the row opens the form and a
 * menu has Edit and Archive (or Bring back).
 */
export function ListRow({
  icon: Icon,
  name,
  archived,
  badges,
  details,
  onEdit,
  onArchive,
  onUnarchive,
}: {
  icon: LucideIcon
  name: string
  archived: boolean
  badges?: ReactNode
  details: ReactNode
  /** Absent for members who may only look. */
  onEdit?: () => void
  onArchive?: () => void
  onUnarchive?: () => void
}) {
  const { t } = useTranslation()
  const face = (
    <>
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          archived ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span dir="auto" className="min-w-0 font-medium break-words">
            {name}
          </span>
          {badges}
          {archived ? <Badge>{t('catalog.list.archivedBadge')}</Badge> : null}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{details}</span>
      </span>
    </>
  )
  if (!onEdit) {
    return <div className="flex items-start gap-3 px-4 py-3.5 sm:px-5">{face}</div>
  }
  return (
    <div className="flex items-start gap-1 pe-2 transition-colors hover:bg-muted/40">
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-2xl px-4 py-3.5 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
      >
        {face}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="mt-2 shrink-0"
            aria-label={t('catalog.list.actions', { name: isolate(name) })}
          >
            <EllipsisVerticalIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem className="py-2" onSelect={onEdit}>
            <PencilIcon aria-hidden />
            {t('catalog.list.edit')}
          </DropdownMenuItem>
          {archived ? (
            <DropdownMenuItem className="py-2" onSelect={onUnarchive}>
              <ArchiveRestoreIcon aria-hidden />
              {t('catalog.list.unarchive')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className="py-2" onSelect={onArchive}>
              <ArchiveIcon aria-hidden />
              {t('catalog.list.archive')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** "Archive X?": what archiving does, then Archive or Cancel. */
export function ArchiveDialog({
  name,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  /** The record being archived; null when the dialog is closed. */
  name: string | null
  busy: boolean
  error: I18nKey | null
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <AlertDialog open={name !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ArchiveIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t('catalog.list.archiveTitle', { name: isolate(name ?? '') })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('catalog.list.archiveBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('actions.cancel')}</AlertDialogCancel>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? t('catalog.list.archiving') : t('catalog.list.archive')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
