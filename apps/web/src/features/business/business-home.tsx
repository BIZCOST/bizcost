'use client'

import { useMe } from '@bizcost/app-core'
import { terminologyKey } from '@bizcost/i18n'
import { businessSummaryKeys, isRoleTemplateKey, type Capabilities } from '@bizcost/modules'
import { InfoIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LogoMark } from '@/components/brand/logo'
import { STATEMENT_ICONS } from '@/features/setup/icons'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'

// The business home for now (M1 Step 5): a welcome card with the business name and what its setup
// says about it (docs/PRODUCT.md §6.8), from the saved capabilities. Only real data: the sections
// themselves appear when they are released (Step 7 builds the dashboard and the app shell).

type SummaryKey = keyof typeof STATEMENT_ICONS

function summaryKeyOf(key: string): SummaryKey {
  // `setup.cap.<capability>.<on|off>`
  return key.split('.')[2] as SummaryKey
}

function roleKey(template: string | null) {
  return isRoleTemplateKey(template) ? (`roles.${template}` as const) : 'roles.custom'
}

export function BusinessHome({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const { data: context } = useBusinessContext()
  const membership = me?.memberships.find((m) => m.businessId === businessId)
  if (!membership || !context) return null
  const summary = businessSummaryKeys(context.capabilities as Capabilities)

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10 lg:py-12">
      <section
        aria-labelledby="business-title"
        className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
      >
        <div className="relative isolate overflow-hidden bg-linear-to-br from-brand to-primary px-5 py-7 text-white sm:px-8 sm:py-9 rtl:bg-linear-to-bl">
          <LogoMark
            inverse
            className="absolute -end-4 -bottom-6 -z-10 size-40 opacity-15 sm:end-6 sm:size-48"
          />
          <p className="text-sm font-medium text-white/80">{t('home.welcome')}</p>
          <h1
            id="business-title"
            className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            <span dir="auto" className="block truncate text-start">
              {membership.legalName}
            </span>
          </h1>
          <p className="mt-1.5 text-sm text-white/80">{t(roleKey(membership.roleTemplateKey))}</p>
        </div>
        <div className="p-5 sm:p-8">
          <h2 className="text-base font-semibold">{t('setup.review.groups.about')}</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summary.map((key) => {
              const Icon = STATEMENT_ICONS[summaryKeyOf(key)]
              const on = key.endsWith('.on')
              return (
                <li
                  key={key}
                  data-statement={summaryKeyOf(key)}
                  className="flex items-center gap-3 rounded-xl border bg-background/60 p-3.5"
                >
                  <span
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-xl',
                      on ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon aria-hidden className="size-5" />
                  </span>
                  <span className="min-w-0 leading-snug font-medium">
                    {t(terminologyKey(key, context.terminologyProfile))}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="mt-6 flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground">
            <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('business.sectionsNote')}
          </p>
        </div>
      </section>
    </div>
  )
}
