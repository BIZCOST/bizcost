'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  BUSINESS_NAME_MAX_LENGTH,
  withoutControlCharacters,
  type BusinessProfileDto,
} from '@bizcost/contracts'
import { parseTrn, type TrnError } from '@bizcost/domain'
import { intlLocale, type I18nKey } from '@bizcost/i18n'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Section } from '@/features/account/section'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { LogoSection } from './logo-section'
import { useModuleNames } from './module-names'
import { useProfile, useProfileSaved } from './profile-data'
import { LoadError, SectionSkeleton } from './query-state'
import { can, isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Business profile (ROADMAP.md Step 6): logo, legal names, VAT and TRN, and the region
// BizCost works in (read-only in M1). One form saves names and VAT together (business.updateProfile,
// with the version read: a change made elsewhere meanwhile is refused, not overwritten).

const TRN_ERRORS: Readonly<Record<TrnError, I18nKey>> = {
  required: 'settings.business.vat.trnRequired',
  invalid_chars: 'settings.business.vat.trnDigits',
  invalid_length: 'settings.business.vat.trnLength',
}

/** A one-line name: a pasted tab or line break becomes a space (the API refuses control characters). */
const nameField = (required: boolean) =>
  z
    .string()
    .check(
      z.overwrite(withoutControlCharacters),
      z.trim(),
      ...(required ? [z.minLength(1, { error: 'settings.business.nameRequired' })] : []),
      z.maxLength(BUSINESS_NAME_MAX_LENGTH, { error: 'settings.business.nameTooLong' }),
    )

const profileSchema = z
  .object({
    legalName: nameField(true),
    legalNameAr: nameField(false),
    vatRegistered: z.boolean(),
    trn: z.string(),
  })
  .superRefine((value, ctx) => {
    if (!value.vatRegistered) return
    const trn = parseTrn(value.trn)
    if (!trn.ok) ctx.addIssue({ code: 'custom', path: ['trn'], message: TRN_ERRORS[trn.error] })
  })
type ProfileForm = z.input<typeof profileSchema>

function formOf(profile: BusinessProfileDto): ProfileForm {
  return {
    legalName: profile.legalName,
    legalNameAr: profile.legalNameAr ?? '',
    vatRegistered: profile.vatRegistered,
    trn: profile.trn ?? '',
  }
}

function DetailsForm({
  profile,
  canEdit,
  onReload,
}: {
  profile: BusinessProfileDto
  canEdit: boolean
  onReload: () => void
}) {
  const { t } = useTranslation()
  const message = useMessage()
  const trpc = useTRPC()
  const saved = useProfileSaved()
  const moduleNames = useModuleNames()
  const vatId = useId()
  const update = useMutation(trpc.business.updateProfile.mutationOptions())
  const [conflict, setConflict] = useState(false)
  const form = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: formOf(profile),
  })
  const vatRegistered = useWatch({ control: form.control, name: 'vatRegistered' })
  const errors = form.formState.errors
  const nameError = (field: 'legalName' | 'legalNameAr') =>
    message(errors[field]?.message, { count: BUSINESS_NAME_MAX_LENGTH })

  const submit = form.handleSubmit(async (values) => {
    setConflict(false)
    try {
      const result = await update.mutateAsync({
        version: profile.version,
        legalName: values.legalName,
        legalNameAr: values.legalNameAr === '' ? null : values.legalNameAr,
        vatRegistered: values.vatRegistered,
        trn: values.vatRegistered ? values.trn : null,
      })
      saved(result.profile)
      const effects = [
        result.turnedOn.length > 0
          ? `${t('setup.review.alsoOn')} ${moduleNames(result.turnedOn)}`
          : null,
        result.turnedOff.length > 0
          ? `${t('setup.review.alsoOff')} ${moduleNames(result.turnedOff)}`
          : null,
      ].filter(Boolean)
      toast.success(t('settings.business.saved'), {
        description: effects.length > 0 ? effects.join(' ') : undefined,
      })
    } catch (error) {
      if (apiErrorCode(error) === 'conflict') {
        setConflict(true)
        return
      }
      toast.error(t(apiErrorKey(error)))
    }
  })

  const vatChanged = vatRegistered !== profile.vatRegistered

  return (
    <form method="post" noValidate onSubmit={submit} className="space-y-6">
      <Section
        title={t('settings.business.details.title')}
        description={t('settings.business.details.description')}
      >
        <div className="space-y-5">
          <TextField
            label={t('settings.business.legalName')}
            autoComplete="organization"
            dir="auto"
            readOnly={!canEdit}
            hint={(id) => (
              <p id={id} className="text-sm text-muted-foreground">
                {t('settings.business.legalNameHint')}
              </p>
            )}
            error={nameError('legalName')}
            {...form.register('legalName')}
          />
          <TextField
            label={t('settings.business.legalNameAr')}
            lang="ar"
            dir="rtl"
            readOnly={!canEdit}
            hint={(id) => (
              <p id={id} className="text-sm text-muted-foreground">
                {t('settings.business.legalNameArHint')}
              </p>
            )}
            error={nameError('legalNameAr')}
            {...form.register('legalNameAr')}
          />
        </div>
      </Section>

      <Section
        title={t('settings.business.vat.title')}
        description={t('settings.business.vat.description')}
      >
        <div className="space-y-5">
          {profile.vatRegistered && !profile.trn ? (
            <FormAlert tone="info">{t('settings.business.vat.trnMissing')}</FormAlert>
          ) : null}
          <div className="flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-4">
            <div className="min-w-0">
              <p id={`${vatId}-label`} className="font-medium">
                {t('settings.business.vat.registered')}
              </p>
              <p id={`${vatId}-hint`} className="mt-0.5 text-sm text-muted-foreground">
                {t('settings.business.vat.registeredHint')}
              </p>
            </div>
            <Controller
              control={form.control}
              name="vatRegistered"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={!canEdit}
                  aria-labelledby={`${vatId}-label`}
                  aria-describedby={`${vatId}-hint`}
                  className="mt-1"
                />
              )}
            />
          </div>
          {vatRegistered ? (
            <TextField
              label={t('settings.business.vat.trn')}
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              readOnly={!canEdit}
              className="tabular-nums rtl:text-end"
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('settings.business.vat.trnHint')}
                </p>
              )}
              error={message(errors.trn?.message)}
              {...form.register('trn')}
            />
          ) : null}
          {canEdit && vatChanged ? (
            <FormAlert tone="info">
              {vatRegistered
                ? t('settings.business.vat.turningOn')
                : t('settings.business.vat.turningOff')}
            </FormAlert>
          ) : null}
        </div>
      </Section>

      {conflict ? (
        <FormAlert tone="error">
          <p>{t('settings.business.conflict')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-9 bg-card"
            onClick={onReload}
          >
            {t('settings.business.reload')}
          </Button>
        </FormAlert>
      ) : null}

      {canEdit ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!form.formState.isDirty || form.formState.isSubmitting}
            onClick={() => form.reset(formOf(profile))}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            className="min-w-28"
            disabled={!form.formState.isDirty || form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? t('status.saving') : t('settings.business.save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

function displayName(locale: string, type: 'region' | 'currency', code: string): string {
  try {
    return new Intl.DisplayNames([locale], { type }).of(code) ?? code
  } catch {
    return code
  }
}

function timeZoneName(locale: string, timeZone: string): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
    )
  } catch {
    return timeZone
  }
}

/** Currency, country and time zone: fixed for every business in M1 (UAE, AED). */
function RegionSection({ profile }: { profile: BusinessProfileDto }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const intl = intlLocale(locale)
  const rows = [
    {
      label: t('settings.business.region.currency'),
      value: displayName(intl, 'currency', profile.currency),
      code: profile.currency,
    },
    {
      label: t('settings.business.region.country'),
      value: displayName(intl, 'region', profile.country),
      code: null,
    },
    {
      label: t('settings.business.region.timezone'),
      value: timeZoneName(intl, profile.timezone),
      code: profile.timezone,
    },
  ]
  return (
    <Section
      title={t('settings.business.region.title')}
      description={t('settings.business.region.description')}
    >
      <dl className="grid gap-3 sm:grid-cols-3 md:grid-cols-1">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0 rounded-xl border bg-background/60 px-4 py-3">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="mt-0.5 text-sm font-medium">
              {row.value}
              {row.code && row.code !== row.value ? (
                <>
                  {' '}
                  <bdi dir="ltr" className="font-normal text-muted-foreground">
                    ({row.code})
                  </bdi>
                </>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

export function BusinessProfileSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  const profile = useProfile(context ? isSectionVisible(context, 'business') : false)
  const canEdit = context ? can(context, 'settings.business.edit') : false
  return (
    <SectionPage businessId={businessId} section="business">
      {!canEdit ? <FormAlert tone="info">{t('settings.readOnly')}</FormAlert> : null}
      {profile.isPending ? (
        <SectionSkeleton cards={3} />
      ) : profile.isError ? (
        <LoadError error={profile.error} onRetry={() => void profile.refetch()} />
      ) : (
        <>
          <LogoSection profile={profile.data} canEdit={canEdit} />
          <DetailsForm
            key={profile.data.version}
            profile={profile.data}
            canEdit={canEdit}
            onReload={() => void profile.refetch()}
          />
          <RegionSection profile={profile.data} />
        </>
      )}
    </SectionPage>
  )
}
