'use client'

import type { BusinessContextDto, RoleDto } from '@bizcost/contracts'
import { formatList } from '@bizcost/i18n'
import { isRoleTemplateKey, PERMISSION_CATALOG } from '@bizcost/modules'
import { CheckIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocale } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { permissionLabelKey } from './permission-groups'
import { canGrantRole, isTemplateDefault, roleNameKey } from './role-labels'

/** A role's name: the template's name in the page's language, or the custom role's own name. */
export function useRoleName() {
  const { t } = useTranslation()
  return (role: { templateKey?: string | null; roleTemplateKey?: string | null; name: string }) => {
    const key = roleNameKey(role.templateKey ?? role.roleTemplateKey ?? null)
    return key ? t(key) : role.name
  }
}

/** Labels named in a changed role's summary before "and N more". */
const SUMMARY_LABELS = 3

/**
 * What a role lets someone do, in one line: a template's own description while the role still grants
 * exactly the template's permissions, else what the changed role allows, in plain words.
 */
export function useRoleSummary() {
  const { t } = useTranslation()
  const { locale } = useLocale()
  return (role: RoleDto) => {
    if (role.isOwner) return t('settings.roleInfo.owner')
    if (isRoleTemplateKey(role.templateKey) && isTemplateDefault(role)) {
      return t(`settings.roleInfo.${role.templateKey}`)
    }
    const granted = new Set(role.permissionKeys)
    const keys = PERMISSION_CATALOG.filter((key) => granted.has(key))
    if (keys.length === 0) return t('settings.roleInfo.customNone')
    const shown = keys.length > SUMMARY_LABELS + 1 ? keys.slice(0, SUMMARY_LABELS) : keys
    // The labels start a sentence ("See costs"); inside one, English writes them in lower case.
    const labels = shown.map((key) => {
      const label = t(permissionLabelKey(key))
      return locale === 'en' ? label.charAt(0).toLowerCase() + label.slice(1) : label
    })
    const rest = keys.length - shown.length
    const items = rest > 0 ? [...labels, t('settings.roleInfo.more', { count: rest })] : labels
    return t('settings.roleInfo.custom', { list: formatList(locale, items) })
  }
}

/**
 * The roles someone can be given (never the Owner role: ownership moves only by a transfer), as radio
 * cards. A role with access the member doesn't have is shown but cannot be chosen.
 */
export function RolePicker({
  name,
  roles,
  access,
  value,
  onChange,
  legend,
  disabled,
}: {
  name: string
  roles: readonly RoleDto[]
  access: Pick<BusinessContextDto, 'permissions'>
  value: string | null
  onChange: (roleId: string) => void
  legend: string
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const roleName = useRoleName()
  const summary = useRoleSummary()
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2">
        {roles
          .filter((role) => !role.isOwner)
          .map((role) => {
            const allowed = canGrantRole(access, role)
            return (
              <label
                key={role.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border bg-card px-3.5 py-3 transition-colors hover:bg-muted/50',
                  'has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-3 has-focus-visible:ring-ring',
                  'has-disabled:cursor-not-allowed has-disabled:opacity-60 has-disabled:hover:bg-card',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={role.id}
                  checked={value === role.id}
                  disabled={!allowed}
                  onChange={() => onChange(role.id)}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                    value === role.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input',
                  )}
                >
                  {value === role.id ? <CheckIcon className="size-3" /> : null}
                </span>
                <span className="min-w-0">
                  <span dir="auto" className="block text-start font-medium">
                    {roleName(role)}
                  </span>
                  <span className="block text-sm leading-snug text-muted-foreground">
                    {allowed ? summary(role) : t('settings.roleInfo.notYours')}
                  </span>
                </span>
              </label>
            )
          })}
      </div>
    </fieldset>
  )
}
