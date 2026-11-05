'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  BETA_EMAIL_MAX_LENGTH,
  BETA_NOTE_MAX_LENGTH,
  betaAddInput,
  type BetaEntryDto,
  type PlatformFeedbackItemDto,
} from '@bizcost/contracts'
import { formatDate, type I18nKey } from '@bizcost/i18n'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Section } from '@/features/account/section'
import { useLocale } from '@/lib/i18n/client'

// The owner's beta page (D-357). The beta list: who may create an account while sign-up is closed
// (D-355). The feedback: what people sent (D-356), with nothing else of their businesses.

const dateOf = (locale: 'en' | 'ar', iso: string) =>
  formatDate(locale, new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

function BetaEntry({ entry, onRemoved }: { entry: BetaEntryDto; onRemoved: () => void }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const remove = useMutation(trpc.platform.betaRemove.mutationOptions())
  const [confirming, setConfirming] = useState(false)
  return (
    <li data-beta-entry className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p dir="ltr" className="truncate text-sm font-medium rtl:text-end">
          {entry.email}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {entry.note ? (
            <>
              <bdi>{entry.note}</bdi>
              {' · '}
            </>
          ) : null}
          {t('platform.list.addedOn', { date: dateOf(locale, entry.createdAt) })}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        disabled={remove.isPending}
        aria-label={t('platform.list.remove', { email: entry.email })}
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon aria-hidden />
      </Button>
      {/* A mis-tap on a phone must not refuse someone: the page keeps no record of who went. */}
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => !remove.isPending && setConfirming(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('platform.list.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('platform.list.removeBody', { email: entry.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t('actions.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { id: entry.id },
                  {
                    onSuccess: () => {
                      toast.success(t('platform.list.removed', { email: entry.email }))
                      setConfirming(false)
                      onRemoved()
                    },
                    onError: (error) => {
                      setConfirming(false)
                      toast.error(t(apiErrorKey(error) as I18nKey))
                    },
                  },
                )
              }
            >
              {t('platform.list.removeAction')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

function BetaListSection() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.platform.betaList.queryOptions())
  const add = useMutation(trpc.platform.betaAdd.mutationOptions())
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.platform.betaList.queryKey() })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const parsed = betaAddInput.safeParse({ email, ...(note.trim() ? { note } : {}) })
    if (!parsed.success) {
      setFieldError(t('platform.list.invalid'))
      return
    }
    setFieldError(null)
    add.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(t('platform.list.added'))
        setEmail('')
        setNote('')
        void refresh()
      },
      onError: (caught) => setError(apiErrorKey(caught) as I18nKey),
    })
  }

  return (
    <Section title={t('platform.list.title')} description={t('platform.list.hint')}>
      <form onSubmit={submit} noValidate className="space-y-4" data-beta-form>
        {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
        <TextField
          label={t('platform.list.email')}
          type="email"
          dir="ltr"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={BETA_EMAIL_MAX_LENGTH}
          value={email}
          error={fieldError ?? undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label={t('platform.list.note')}
          dir={note ? 'auto' : undefined}
          placeholder={t('platform.list.notePlaceholder')}
          maxLength={BETA_NOTE_MAX_LENGTH}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? t('platform.list.adding') : t('platform.list.add')}
        </Button>
      </form>
      <div className="mt-6 border-t pt-4">
        {list.isError && !list.data ? (
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('platform.feedback.loading')}
          </p>
        ) : list.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('platform.list.empty')}</p>
        ) : (
          <>
            <p className="mb-1 text-xs text-muted-foreground">
              {t('platform.list.count', { count: list.data.items.length })}
            </p>
            <ul className="divide-y">
              {list.data.items.map((entry) => (
                <BetaEntry key={entry.id} entry={entry} onRemoved={() => void refresh()} />
              ))}
            </ul>
          </>
        )}
      </div>
    </Section>
  )
}

function FeedbackItem({ item }: { item: PlatformFeedbackItemDto }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const who = [item.memberName, item.email].filter(Boolean).join(' · ')
  return (
    <li data-feedback-item className="space-y-2 py-4">
      <p
        dir="auto"
        className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {item.message}
      </p>
      {item.imageUrl ? (
        <a href={item.imageUrl} target="_blank" rel="noreferrer" className="block w-fit">
          {/* A signed link to a private file: never through the image optimizer. */}
          <img
            src={item.imageUrl}
            alt={t('platform.feedback.picture')}
            className="max-h-64 max-w-full rounded-lg border object-contain"
          />
        </a>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <dt>{t('platform.feedback.member')}</dt>
        <dd className="[overflow-wrap:anywhere]">
          <bdi>{who || t('platform.feedback.unknownMember')}</bdi>
        </dd>
        <dt>{t('platform.feedback.business')}</dt>
        <dd className="[overflow-wrap:anywhere]">
          <bdi>{item.businessName ?? t('platform.feedback.noBusiness')}</bdi>
        </dd>
        <dt>{t('platform.feedback.page')}</dt>
        <dd dir="ltr" className="truncate rtl:text-end">
          {item.pagePath}
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">{dateOf(locale, item.createdAt)}</p>
    </li>
  )
}

function FeedbackSection() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const feedback = useInfiniteQuery(
    trpc.platform.feedback.infiniteQueryOptions(
      {},
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  )
  const items = feedback.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <Section title={t('platform.feedback.title')} description={t('platform.feedback.hint')}>
      {feedback.isError && !feedback.data ? (
        <LoadError error={feedback.error} onRetry={() => void feedback.refetch()} />
      ) : !feedback.data ? (
        <SectionSkeleton cards={1} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('platform.feedback.empty')}</p>
      ) : (
        <>
          <ul className="divide-y">
            {items.map((item) => (
              <FeedbackItem key={item.id} item={item} />
            ))}
          </ul>
          {feedback.hasNextPage ? (
            <Button
              variant="outline"
              className="mt-2"
              disabled={feedback.isFetchingNextPage}
              onClick={() => void feedback.fetchNextPage()}
            >
              {feedback.isFetchingNextPage
                ? t('platform.feedback.loading')
                : t('platform.feedback.more')}
            </Button>
          ) : null}
        </>
      )}
    </Section>
  )
}

export function PlatformView() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('platform.title')}</h1>
        <p className="mt-1.5 text-muted-foreground">{t('platform.subtitle')}</p>
      </header>
      <div className="space-y-6">
        <BetaListSection />
        <FeedbackSection />
      </div>
    </div>
  )
}
