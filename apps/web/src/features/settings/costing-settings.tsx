'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ProductCostSettingsDto } from '@bizcost/contracts'
import type { CurrencyCode } from '@bizcost/domain'
import { formatDecimal, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RepeatIcon } from 'lucide-react'
import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { Section } from '@/features/account/section'
import { decimalPlaces } from '@/features/catalog/units'
import { useRuleExample } from '@/features/costing/words'
import { hasModule } from '@/features/purchasing/data'
import { MoneyInput } from '@/features/purchasing/purchase-lines'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { settingsChange } from './costing-draft'
import { can, isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → How costs are worked out (M2 Step 6; D-119, D-202; ROADMAP.md M2 Step 7 lists them in
// Settings): what BizCost needs to work out the full cost of what the business sells.
//   - Running costs reach what the business sells by its price (D-202): that they need no setting
//     (each item's share is worked out once sales are recorded; the estimate of monthly purchases is
//     gone), the rule in plain words with the owner's example, and the way to Running Costs and to
//     Product costs (its services words for a business that sells only services, D-200). Said to be
//     off, and nothing else, while Running Costs and Expenses both are.
//   - Without a team, the owner's hourly rate: each product's minutes are counted at it. With a team
//     there is nothing to set: the page explains the rule and leads on, never an empty form.
// Only members with cost_engine.settings.manage (Owner, Admin, Manager) see it; the hourly rate is a
// cost, so a member who may not see costs only reads that it is hidden. Leaving with a change not
// saved asks first. Every change is audited by the API.

type Settings = ProductCostSettingsDto['data']

/** One amount of the settings, its field and its Save. */
function AmountForm({
  field,
  label,
  hint,
  saved,
  suffix,
  onSaved,
}: {
  field: 'hourlyRate'
  label: string
  hint: string
  saved: Settings
  suffix?: string
  onSaved: (settings: ProductCostSettingsDto) => Promise<void>
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const update = useMutation(trpc.productCost.updateSettings.mutationOptions())
  const stored = saved.ownerHourlyRate ?? null
  const [typed, setTyped] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  // What is saved, as the lists write numbers ("30,000"); it reads back the same.
  const value =
    typed ?? (stored === null ? '' : formatDecimal(locale, stored, decimalPlaces(stored)))
  const currency = saved.currency as CurrencyCode
  const change = settingsChange({ hourlyRate: value }, { hourlyRate: stored }, currency)
  const error = change.errors[field]
  const dirty = typed !== null && (change.input !== null || error !== undefined)

  async function save(): Promise<boolean> {
    setSubmitted(true)
    setServerError(null)
    if (error) return false
    if (!change.input) {
      setTyped(null)
      return true
    }
    try {
      const result = await update.mutateAsync(change.input)
      await onSaved(result)
      setTyped(null)
      setSubmitted(false)
      toast.success(t('settings.costing.saved'))
      return true
    } catch (caught) {
      setServerError(apiErrorKey(caught))
      return false
    }
  }
  useUnsavedChanges({ dirty, save })

  function submit(event: FormEvent) {
    event.preventDefault()
    void save()
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate data-setting={field}>
      <TextField
        label={label}
        error={
          error && (submitted || error.key !== 'catalog.numbers.required')
            ? t(error.key, error.values)
            : undefined
        }
        hint={(id) => (
          <p id={id} className="text-sm text-muted-foreground">
            {hint}
          </p>
        )}
        render={(a11y) => (
          <div className="flex items-center gap-2">
            <MoneyInput
              id={a11y.id}
              invalid={a11y['aria-invalid']}
              describedBy={a11y['aria-describedby']}
              value={value}
              onChange={setTyped}
              className="flex-1 sm:max-w-64 sm:flex-none"
            />
            {suffix ? (
              <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span>
            ) : null}
          </div>
        )}
      />
      {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
      <Button type="submit" disabled={update.isPending}>
        {update.isPending ? t('status.saving') : t('actions.save')}
      </Button>
    </form>
  )
}

export function CostingSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const visible = context ? isSectionVisible(context, 'costing') : false
  const settings = useQuery({ ...trpc.productCost.settings.queryOptions(), enabled: visible })
  const example = useRuleExample()

  async function saved(result: ProductCostSettingsDto) {
    queryClient.setQueryData(trpc.productCost.settings.queryKey(), result)
    // Every product's cost moves with them.
    await queryClient.invalidateQueries({ queryKey: trpc.productCost.list.pathKey() })
    await queryClient.invalidateQueries({ queryKey: trpc.productCost.get.pathKey() })
  }

  if (settings.isPending || settings.isError) {
    return (
      <SectionPage businessId={businessId} section="costing">
        {settings.isError ? (
          <LoadError error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <SectionSkeleton cards={2} />
        )}
      </SectionPage>
    )
  }
  const data = settings.data.data
  // Costs hidden for this member (an override): nothing to change here.
  const hidden = data.ownerHourlyRate === undefined
  const shared =
    context === undefined || hasModule(context, 'running_costs') || hasModule(context, 'expenses')
  const servicesOnly = context?.sellsOnlyServices === true
  const runningCosts =
    context && hasModule(context, 'running_costs') && can(context, 'running_costs.items.view') ? (
      <Button asChild variant="outline">
        <Link href={`/b/${businessId}/running-costs`}>
          {t('settings.costing.running.goToRunningCosts')}
        </Link>
      </Button>
    ) : null

  return (
    <SectionPage businessId={businessId} section="costing">
      {hidden ? (
        <FormAlert tone="info">{t('settings.costing.hidden')}</FormAlert>
      ) : (
        <>
          <Section
            title={t(
              servicesOnly
                ? 'settings.costing.running.title_services'
                : 'settings.costing.running.title',
            )}
            description={shared ? t('settings.costing.running.explain') : undefined}
          >
            {shared ? (
              <div className="space-y-4">
                <div
                  data-rule-example
                  className="flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3"
                >
                  <RepeatIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
                  <div className="min-w-0 space-y-1 text-sm leading-relaxed">
                    <p data-rule>{t('costing.rate.byPrice')}</p>
                    <p data-example className="text-muted-foreground">
                      {example()}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {runningCosts}
                  <Button asChild variant="outline">
                    <Link href={`/b/${businessId}/product-costs`}>
                      {t(
                        servicesOnly
                          ? 'settings.costing.running.seeProductCosts_services'
                          : 'settings.costing.running.seeProductCosts',
                      )}
                    </Link>
                  </Button>
                </div>
              </div>
            ) : (
              <FormAlert tone="info">{t('settings.costing.running.off')}</FormAlert>
            )}
          </Section>
          {data.hasTeam ? null : (
            <Section
              title={t('settings.costing.time.title')}
              description={t('settings.costing.time.explain')}
            >
              <AmountForm
                field="hourlyRate"
                label={t('settings.costing.time.rate')}
                hint={t('settings.costing.time.rateHint')}
                saved={data}
                suffix={t('units.per.h')}
                onSaved={saved}
              />
            </Section>
          )}
        </>
      )}
    </SectionPage>
  )
}
