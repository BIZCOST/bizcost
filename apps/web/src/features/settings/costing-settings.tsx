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
import { useEstimateNote, useRateWords, useWholeMoney } from '@/features/costing/words'
import { hasModule } from '@/features/purchasing/data'
import { MoneyInput } from '@/features/purchasing/purchase-lines'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { settingsChange } from './costing-draft'
import { can, isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → How costs are worked out (M2 Step 6; D-116, D-119, D-186; ROADMAP.md M2 Step 7 lists
// them in Settings): what BizCost needs to work out the full cost of what the business sells.
//   - Running costs reach products as a share of their material cost: monthly running costs ÷ the
//     materials bought a month. Until 3 full months of purchases count, that is the owner's estimate,
//     asked here in plain words (without the VAT a registered business gets back); the section says
//     how running costs reach products now, and why the estimate is still in use. The estimate is
//     not asked once the 3 months count, nor while no running cost is entered, nor for a business
//     without Materials (running costs cannot reach services yet); nothing is shown while Running
//     Costs is off.
//   - Without a team, the owner's hourly rate: each product's minutes are counted at it.
// Only members with cost_engine.settings.manage and running costs and purchases (Owner, Admin,
// Manager) see it; the values are costs and supplier prices, so a member who may not see them only
// reads that they are hidden. Each part saves on its own; leaving with a change not saved asks first.
// Every change is audited by the API.

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
  field: 'estimate' | 'hourlyRate'
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
  const stored =
    (field === 'estimate' ? saved.estimatedMonthlyPurchases : saved.ownerHourlyRate) ?? null
  const [typed, setTyped] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  // What is saved, as the lists write numbers ("30,000"); it reads back the same.
  const value =
    typed ?? (stored === null ? '' : formatDecimal(locale, stored, decimalPlaces(stored)))
  const currency = saved.currency as CurrencyCode
  const change = settingsChange(
    { [field]: value },
    {
      estimate: saved.estimatedMonthlyPurchases ?? null,
      hourlyRate: saved.ownerHourlyRate ?? null,
    },
    currency,
  )
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
  const rateWords = useRateWords()
  const estimateNote = useEstimateNote()
  const whole = useWholeMoney()

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
  const hidden = data.estimatedMonthlyPurchases === undefined || data.ownerHourlyRate === undefined
  const materialsOn = context ? hasModule(context, 'materials') : true
  const words = rateWords(data.rate, materialsOn)
  const counted = data.rate.purchases.source === 'last_3_months'
  const note =
    data.rate.state === 'none' ||
    data.rate.state === 'off' ||
    data.rate.state === 'not_entered' ||
    !materialsOn
      ? null
      : estimateNote(data.rate, data.today)
  // The estimate is asked only where it can change something (D-186).
  const asksEstimate = materialsOn && data.rate.state !== 'not_entered' && !counted
  const vatHint = context?.capabilities.vat_registered === true
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
            title={t('settings.costing.running.title')}
            description={t('settings.costing.running.explain')}
          >
            {data.rate.state === 'off' ? (
              <FormAlert tone="info">{t('settings.costing.running.off')}</FormAlert>
            ) : (
              <div className="space-y-5">
                {words ? (
                  <div
                    data-rate-now
                    className="flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3"
                  >
                    <RepeatIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div role="status" className="min-w-0 space-y-1 text-sm leading-relaxed">
                      <p data-rule>{words.rule}</p>
                      {words.why ? <p data-why>{words.why}</p> : null}
                      {note ? <p className="text-muted-foreground">{note}</p> : null}
                      {counted && data.estimatedMonthlyPurchases ? (
                        <p data-estimate-unused className="text-muted-foreground">
                          {t('settings.costing.running.estimateUnused', {
                            estimate: whole(data.estimatedMonthlyPurchases),
                          })}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {data.rate.state === 'not_entered' ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {t('settings.costing.running.notEntered')}
                    </p>
                    {runningCosts}
                  </div>
                ) : null}
                {asksEstimate ? (
                  <AmountForm
                    field="estimate"
                    label={t('settings.costing.running.estimate')}
                    hint={
                      vatHint
                        ? `${t('settings.costing.running.estimateHint')} ${t('settings.costing.running.estimateHintVat')}`
                        : t('settings.costing.running.estimateHint')
                    }
                    saved={data}
                    onSaved={saved}
                  />
                ) : null}
              </div>
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
