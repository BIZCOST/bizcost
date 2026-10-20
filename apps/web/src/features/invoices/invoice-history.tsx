'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import { formatDate } from '@bizcost/i18n'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { useLocale } from '@/lib/i18n/client'

// What happened to an invoice, newest first (M3 Step 8, D-306): made, changed, issued with its number,
// its credit notes, its payments and their reversals (amounts with payments seen), who did it (with a
// team) and when.

export function InvoiceHistory({ invoiceId, currency }: { invoiceId: string; currency: string }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const money = useMoney()
  const trpc = useTRPC()
  const history = useQuery(trpc.invoice.history.queryOptions({ id: invoiceId }))
  const events = history.data?.events ?? []
  return (
    <Panel title={t('documents.invoices.history.title')}>
      {history.isPending ? (
        <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
      ) : history.isError ? (
        <p className="text-sm text-destructive">{t(apiErrorKey(history.error))}</p>
      ) : (
        <ol aria-label={t('documents.invoices.history.title')} className="space-y-3">
          {events.map((event, index) => (
            <li
              key={`${event.kind}-${event.at}-${index}`}
              data-history-event={event.kind}
              className="flex gap-3"
            >
              <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60" />
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {t(`documents.invoices.history.kinds.${event.kind}`, {
                    reference: event.reference ? isolate(event.reference) : '',
                  })}
                  {event.amount ? (
                    <>
                      {' · '}
                      <bdi className="tabular-nums">{money(event.amount, currency)}</bdi>
                    </>
                  ) : null}
                </p>
                <p className="text-muted-foreground">
                  {formatDate(locale, event.at, { dateStyle: 'medium', timeStyle: 'short' })}
                  {event.byName ? (
                    <>
                      {' · '}
                      <bdi>{event.byName}</bdi>
                    </>
                  ) : null}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
