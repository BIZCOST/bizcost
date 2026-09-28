'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import { formatDate, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookLockIcon, BookOpenIcon } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section } from '@/features/account/section'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Closing the books (M2 Step 3; D-114 rule 6, D-137): nothing dated on or before the chosen
// day can be finalized or reversed any more (purchases now; expenses and later documents too). Off by
// default. The day is today at the latest; moving it back or opening the books again is allowed, and
// every change is in the audit log. Only members with purchases.books.close (Owner, Admin) see it.

export function BooksSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const id = useId()
  const { data: context } = useBusinessContext()
  const visible = context ? isSectionVisible(context, 'books') : false
  const books = useQuery({ ...trpc.books.get.queryOptions(), enabled: visible })
  const close = useMutation(trpc.books.close.mutationOptions())
  const [day, setDay] = useState<string | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const date = (value: string) =>
    formatDate(locale, `${value}T00:00:00Z`, { dateStyle: 'long', timeZone: 'UTC' })

  async function save(closedThrough: string | null) {
    setError(null)
    try {
      const saved = await close.mutateAsync({ closedThrough })
      queryClient.setQueryData(trpc.books.get.queryKey(), saved)
      await queryClient.invalidateQueries({ queryKey: trpc.purchase.pathKey() })
      setDay(null)
      toast.success(
        saved.closedThrough
          ? t('settings.books.closed', { date: date(saved.closedThrough) })
          : t('settings.books.opened'),
      )
    } catch (caught) {
      setError(apiErrorKey(caught))
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = day ?? books.data?.closedThrough ?? books.data?.today ?? ''
    if (!value) return
    void save(value)
  }

  return (
    <SectionPage businessId={businessId} section="books">
      <Section title={t('settings.books.sectionTitle')} description={t('settings.books.explain')}>
        {books.isPending ? (
          <SectionSkeleton cards={1} />
        ) : books.isError ? (
          <LoadError error={books.error} onRetry={() => void books.refetch()} />
        ) : (
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3">
              {books.data.closedThrough ? (
                <BookLockIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
              ) : (
                <BookOpenIcon
                  aria-hidden
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                />
              )}
              <p role="status" className="text-sm">
                {books.data.closedThrough
                  ? t('settings.books.statusClosed', { date: date(books.data.closedThrough) })
                  : t('settings.books.statusOpen')}
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-day`} className="text-sm font-medium">
                {t('settings.books.closeThrough')}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id={`${id}-day`}
                  type="date"
                  max={books.data.today}
                  value={day ?? books.data.closedThrough ?? books.data.today}
                  onChange={(event) => setDay(event.target.value)}
                  aria-describedby={`${id}-hint`}
                  className="sm:max-w-56"
                />
                <Button type="submit" disabled={close.isPending}>
                  {close.isPending ? t('status.saving') : t('settings.books.close')}
                </Button>
              </div>
              <p id={`${id}-hint`} className="text-sm text-muted-foreground">
                {t('settings.books.closeHint')}
              </p>
            </div>
            {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
            {books.data.closedThrough ? (
              <div className="border-t pt-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={close.isPending}
                  onClick={() => void save(null)}
                >
                  <BookOpenIcon aria-hidden />
                  {t('settings.books.open')}
                </Button>
                <p className="mt-2 text-sm text-muted-foreground">{t('settings.books.openHint')}</p>
              </div>
            ) : null}
          </form>
        )}
      </Section>
    </SectionPage>
  )
}
