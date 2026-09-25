'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import { LOCALES, type Locale } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Button } from '@/components/ui/button'
import { Section } from '@/features/account/section'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { useProfile, useProfileSaved } from './profile-data'
import { LoadError, SectionSkeleton } from './query-state'
import { can, isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Language (ROADMAP.md Step 6): the business's language (businesses.default_locale: the
// language invitations are sent in unless the inviter picks another) and a way to the member's own
// language, which is set in their account.

/** Radio cards of the two languages; saved as soon as one is chosen. */
export function LanguageChoice({
  name,
  value,
  onChange,
  disabled,
  legend,
  showLegend = false,
}: {
  name: string
  value: Locale
  onChange: (locale: Locale) => void
  disabled?: boolean
  legend: string
  /** Shown above the choices (else read by screen readers only, when a heading says the same). */
  showLegend?: boolean
}) {
  const { t } = useTranslation()
  return (
    <fieldset disabled={disabled}>
      <legend className={showLegend ? 'mb-2 text-sm font-medium' : 'sr-only'}>{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {LOCALES.map((locale) => (
          <label
            key={locale}
            lang={locale}
            className={cn(
              'flex h-14 cursor-pointer items-center justify-between gap-3 rounded-xl border bg-card px-4 text-[0.9375rem] font-medium transition-colors hover:bg-muted/50',
              'has-checked:border-primary has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring',
              'has-disabled:cursor-default has-disabled:opacity-70 has-disabled:hover:bg-card has-disabled:has-checked:hover:bg-accent',
            )}
          >
            <input
              type="radio"
              name={name}
              value={locale}
              checked={value === locale}
              onChange={() => onChange(locale)}
              className="sr-only"
            />
            {t(`language.${locale}`)}
            {value === locale ? (
              <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <CheckIcon aria-hidden className="size-3.5" />
              </span>
            ) : (
              <span aria-hidden className="size-6 rounded-full border-2 border-input" />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function LanguageSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { locale } = useLocale()
  const { data: context } = useBusinessContext()
  const profile = useProfile(context ? isSectionVisible(context, 'language') : false)
  const saved = useProfileSaved()
  const update = useMutation(trpc.business.setDefaultLocale.mutationOptions())
  const canEdit = context ? can(context, 'settings.business.edit') : false

  async function choose(defaultLocale: Locale) {
    if (!profile.data || defaultLocale === profile.data.defaultLocale || update.isPending) return
    try {
      saved(await update.mutateAsync({ defaultLocale }))
      toast.success(t('settings.language.saved'))
    } catch (error) {
      toast.error(t(apiErrorKey(error)))
    }
  }

  return (
    <SectionPage businessId={businessId} section="language">
      <Section
        title={t('settings.language.business.title')}
        description={t('settings.language.business.description')}
      >
        {profile.isPending ? (
          <SectionSkeleton cards={1} />
        ) : profile.isError ? (
          <LoadError error={profile.error} onRetry={() => void profile.refetch()} />
        ) : (
          <div className="space-y-4">
            <LanguageChoice
              name="business-language"
              legend={t('settings.language.business.title')}
              value={
                update.isPending && update.variables
                  ? update.variables.defaultLocale
                  : profile.data.defaultLocale
              }
              onChange={(next) => void choose(next)}
              disabled={!canEdit || update.isPending}
            />
            {!canEdit ? <FormAlert tone="info">{t('settings.readOnly')}</FormAlert> : null}
          </div>
        )}
      </Section>
      <Section
        title={t('settings.language.yours.title')}
        description={t('settings.language.yours.description')}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3">
          <p className="text-sm">
            <span className="text-muted-foreground">{t('settings.language.yours.current')} </span>
            <span lang={locale} className="font-medium">
              {t(`language.${locale}`)}
            </span>
          </p>
          <Button asChild variant="outline">
            <Link href="/account#language">
              {t('settings.language.yours.change')}
              <ArrowRightIcon aria-hidden className="rtl:rotate-180" />
            </Link>
          </Button>
        </div>
      </Section>
    </SectionPage>
  )
}
