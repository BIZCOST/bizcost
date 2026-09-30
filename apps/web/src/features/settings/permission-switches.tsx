'use client'

import type { TerminologyProfile } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import type { PermissionKey, SensitiveDataSwitch } from '@bizcost/modules'
import { LockKeyholeIcon, ShieldIcon } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useTerminology } from '@/lib/i18n/client'
import {
  groupTitleKey,
  isSwitchOn,
  permissionHintKey,
  permissionLabelKey,
  sensitiveHintKey,
  sensitiveLabelKey,
  switchPermission,
  switchSensitive,
  type PermissionGroup,
} from './permission-groups'

// The permission switches of the Roles editor and of a member's own permissions (M2 Step 7, D-190,
// D-191): the sensitive-data section first ("See costs, supplier prices and margins" as one switch:
// the one an owner most often comes for, D-200), then the groups in plain words. Switching a permission on also switches on what it needs, and off what
// needs it (switchPermission; the API refuses anything else). With `baseline` (a member's role), each
// switch that differs from it says so: "Added" or "Removed".

function Row({
  id,
  switchKey,
  label,
  hint,
  checked,
  allowed,
  disabled,
  change,
  onChange,
}: {
  id: string
  /** The permission key, or `sensitive:<id>` for a sensitive-data switch (to find the row). */
  switchKey: string
  label: string
  hint: string
  checked: boolean
  allowed: boolean
  disabled: boolean
  /** How it differs from the baseline, if it does. */
  change: 'added' | 'removed' | null
  onChange: (on: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <li
      className="flex scroll-mt-24 items-start gap-4 px-3.5 py-3"
      data-permission={id}
      data-permission-key={switchKey}
    >
      <div className="min-w-0 flex-1">
        <p
          id={`${id}-label`}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-medium"
        >
          {label}
          {allowed ? null : (
            <LockKeyholeIcon
              aria-label={t('settings.roles.locked')}
              role="img"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
          {change ? (
            <Badge tone={change === 'added' ? 'primary' : 'warning'} data-change={change}>
              {t(`settings.memberAccess.${change}`)}
            </Badge>
          ) : null}
        </p>
        <p id={`${id}-hint`} className="mt-0.5 text-sm text-muted-foreground">
          {hint}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={!allowed || disabled}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
    </li>
  )
}

export function PermissionSwitches({
  groups,
  sensitive,
  keys,
  onChange,
  canGrant,
  disabled,
  baseline,
  profile,
}: {
  groups: readonly PermissionGroup[]
  /** The sensitive-data switches offered (offeredSensitiveSwitches). */
  sensitive: readonly SensitiveDataSwitch[]
  keys: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  /** Whether the editor may switch this key (their own access, canGrantKey). */
  canGrant: (key: string) => boolean
  disabled: boolean
  /** A member's role keys: switches that differ are marked. */
  baseline?: ReadonlySet<string>
  profile: TerminologyProfile | null | undefined
}) {
  const { t } = useTranslation()
  // The business's wording: a café's "See recipes", "Ingredients & supplies" (D-118).
  const term = useTerminology()
  const ids = useId()
  const changeOf = (now: boolean, before: boolean | undefined) =>
    before === undefined || now === before ? null : now ? 'added' : 'removed'
  const tt = (key: I18nKey) => term(key, profile)
  return (
    <>
      {sensitive.length > 0 ? (
        <fieldset className="space-y-1" disabled={disabled} data-sensitive-section>
          <legend className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <ShieldIcon aria-hidden className="size-4 text-primary" />
            {t('settings.roles.groups.data')}
          </legend>
          <p className="pb-1 text-sm text-muted-foreground">{t('settings.sensitive.note')}</p>
          <ul className="divide-y rounded-xl border border-primary/25 bg-accent/30">
            {sensitive.map((item) => {
              const on = isSwitchOn(keys, item)
              return (
                <Row
                  key={item.id}
                  id={`${ids}-sensitive-${item.id}`}
                  switchKey={`sensitive:${item.id}`}
                  label={tt(sensitiveLabelKey(item))}
                  hint={tt(sensitiveHintKey(item))}
                  checked={on}
                  allowed={item.keys.every(canGrant)}
                  disabled={disabled}
                  change={changeOf(on, baseline ? isSwitchOn(baseline, item) : undefined)}
                  onChange={(next) => onChange(switchSensitive(keys, item, next))}
                />
              )
            })}
          </ul>
        </fieldset>
      ) : null}
      {groups.map((group) => (
        <fieldset key={group.id} className="space-y-1" disabled={disabled}>
          <legend className="mb-1 text-sm font-semibold">{tt(groupTitleKey(group.id))}</legend>
          <ul className="divide-y rounded-xl border">
            {group.keys.map((key: PermissionKey) => (
              <Row
                key={key}
                id={`${ids}-${key.replaceAll('.', '-')}`}
                switchKey={key}
                label={tt(permissionLabelKey(key))}
                hint={tt(permissionHintKey(key))}
                checked={keys.has(key)}
                allowed={canGrant(key)}
                disabled={disabled}
                change={changeOf(keys.has(key), baseline?.has(key))}
                onChange={(on) => onChange(switchPermission(keys, key, on))}
              />
            ))}
          </ul>
        </fieldset>
      ))}
    </>
  )
}
