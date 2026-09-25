'use client'

import { apiErrorKey } from '@bizcost/app-core'
import { RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Loading and failed states of a settings section's data.

/** Placeholder cards while a section loads; screen readers hear "Loading…" once. */
export function SectionSkeleton({ cards = 2 }: { cards?: number }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <p role="status" className="sr-only">
        {t('status.loading')}
      </p>
      {Array.from({ length: cards }, (_, index) => (
        <div
          key={index}
          className="space-y-4 rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06] sm:p-6"
        >
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
    </div>
  )
}

/** The section's data could not be loaded: the reason (from the API's error code) and a retry. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <FormAlert tone="error">
      <p>{t(apiErrorKey(error))}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-9 bg-card"
        onClick={onRetry}
      >
        <RotateCwIcon aria-hidden />
        {t('actions.tryAgain')}
      </Button>
    </FormAlert>
  )
}
