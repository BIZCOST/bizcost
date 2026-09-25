'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, RoleDto } from '@bizcost/contracts'
import { formatList } from '@bizcost/i18n'
import type { PermissionKey } from '@bizcost/modules'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDownIcon,
  CrownIcon,
  InfoIcon,
  LockKeyholeIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import {
  groupTitleKey,
  permissionHintKey,
  permissionLabelKey,
  switchPermission,
  visiblePermissionGroups,
  type PermissionGroup,
} from './permission-groups'
import { LoadError, SectionSkeleton } from './query-state'
import { canGrantKey, canGrantRole } from './role-labels'
import { useRoleName, useRoleSummary } from './role-picker'
import { isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Roles (ROADMAP.md Step 6; docs/PRODUCT.md §8): the business's roles, copied from the
// templates at setup. The Owner can do everything and is not edited; the others' permissions are
// switched in plain words, grouped by area (private data and, for one location, branches are not
// offered: D-084; their keys stay as they are). Only a role that grants nothing beyond the editor's own
// access can be edited, and taking access away from your own role asks first. Saving applies right
// away to everyone with the role (the API bumps their permissions version). No custom roles or
// per-person exceptions in M1.

/** The member's own role (one role per template in M1, so the template names it). */
function isOwnRole(role: RoleDto, access: BusinessContextDto): boolean {
  return role.templateKey !== null && role.templateKey === access.roleTemplateKey
}

function PermissionEditor({
  role,
  access,
  groups,
  onDone,
}: {
  role: RoleDto
  access: BusinessContextDto
  groups: readonly PermissionGroup[]
  onDone: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const roleName = useRoleName()
  const ids = useId()
  const update = useMutation(trpc.role.updatePermissions.mutationOptions())
  const [keys, setKeys] = useState<Set<string>>(() => new Set(role.permissionKeys))
  const [conflict, setConflict] = useState(false)
  const [losing, setLosing] = useState<PermissionKey[] | null>(null)
  const own = isOwnRole(role, access)
  const changed =
    keys.size !== role.permissionKeys.length || role.permissionKeys.some((key) => !keys.has(key))
  const locked = groups.some((group) => group.keys.some((key) => !canGrantKey(access, key)))

  async function save() {
    setConflict(false)
    try {
      await update.mutateAsync({ id: role.id, version: role.version, permissionKeys: [...keys] })
      await queryClient.invalidateQueries({ queryKey: trpc.role.list.queryKey() })
      // Your own access changed: the sections you may open follow.
      if (own) await queryClient.invalidateQueries({ queryKey: trpc.business.context.queryKey() })
      toast.success(t('settings.roles.saved', { role: isolate(roleName(role)) }))
      onDone()
    } catch (error) {
      if (apiErrorCode(error) === 'conflict') {
        setConflict(true)
        await queryClient.invalidateQueries({ queryKey: trpc.role.list.queryKey() })
        return
      }
      toast.error(t(apiErrorKey(error)))
    }
  }

  function submit() {
    // Taking access away from your own role: say what you lose first.
    const lost = own ? (role.permissionKeys.filter((key) => !keys.has(key)) as PermissionKey[]) : []
    if (lost.length > 0) setLosing(lost)
    else void save()
  }

  return (
    <form
      method="post"
      noValidate
      className="space-y-5 border-t px-4 pt-4 pb-5 sm:px-5"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {own ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          {t('settings.roles.ownRoleNote')}
        </p>
      ) : null}
      {locked ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <LockKeyholeIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('settings.roles.lockedNote')}
        </p>
      ) : null}
      {groups.map((group) => (
        <fieldset key={group.id} className="space-y-1" disabled={update.isPending}>
          <legend className="mb-1 text-sm font-semibold">{t(groupTitleKey(group.id))}</legend>
          <ul className="divide-y rounded-xl border">
            {group.keys.map((key: PermissionKey) => {
              const id = `${ids}-${key.replaceAll('.', '-')}`
              const allowed = canGrantKey(access, key)
              return (
                <li key={key} className="flex items-start gap-4 px-3.5 py-3">
                  <div className="min-w-0 flex-1">
                    <p id={`${id}-label`} className="flex items-center gap-1.5 text-sm font-medium">
                      {t(permissionLabelKey(key))}
                      {allowed ? null : (
                        <LockKeyholeIcon
                          aria-label={t('settings.roles.locked')}
                          role="img"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      )}
                    </p>
                    <p id={`${id}-hint`} className="mt-0.5 text-sm text-muted-foreground">
                      {t(permissionHintKey(key))}
                    </p>
                  </div>
                  <Switch
                    checked={keys.has(key)}
                    disabled={!allowed || update.isPending}
                    onCheckedChange={(on) =>
                      setKeys((current) => switchPermission(current, key, on))
                    }
                    aria-labelledby={`${id}-label`}
                    aria-describedby={`${id}-hint`}
                    className="mt-0.5"
                  />
                </li>
              )
            })}
          </ul>
        </fieldset>
      ))}
      {conflict ? <FormAlert tone="error">{t('settings.roles.conflict')}</FormAlert> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={update.isPending} onClick={onDone}>
          {t('actions.cancel')}
        </Button>
        <Button type="submit" disabled={!changed || update.isPending} className="min-w-28">
          {update.isPending ? t('status.saving') : t('settings.roles.save')}
        </Button>
      </div>
      <AlertDialog
        open={losing !== null}
        onOpenChange={(open) => !open && !update.isPending && setLosing(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-warning/10 text-warning">
              <ShieldAlertIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('settings.roles.ownRoleTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.roles.ownRoleBody', {
                list: formatList(
                  locale,
                  (losing ?? []).map((key) => t(permissionLabelKey(key))),
                ),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={update.isPending}>{t('actions.cancel')}</AlertDialogCancel>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={update.isPending}
              onClick={() => {
                void save().finally(() => setLosing(null))
              }}
            >
              {update.isPending ? t('status.saving') : t('settings.roles.ownRoleConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}

function RoleCard({
  role,
  access,
  groups,
  open,
  onToggle,
}: {
  role: RoleDto
  access: BusinessContextDto
  groups: readonly PermissionGroup[]
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const roleName = useRoleName()
  const summary = useRoleSummary()
  const ids = useId()
  const Icon = role.isOwner ? CrownIcon : ShieldCheckIcon
  // A role with access the member doesn't have is left alone (the API refuses it too).
  const editable = canGrantRole(access, role)
  return (
    <li
      className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
      data-role={role.templateKey ?? role.name}
    >
      <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl',
            role.isOwner ? 'bg-accent text-primary' : 'bg-muted text-foreground',
          )}
        >
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 id={`${ids}-name`} className="font-semibold">
              <span dir="auto">{roleName(role)}</span>
            </h2>
            <Badge>{t('settings.roles.people', { count: role.memberCount })}</Badge>
            {isOwnRole(role, access) ? (
              <Badge tone="primary">{t('settings.roles.yourRole')}</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{summary(role)}</p>
          {!role.isOwner && !editable ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted-foreground">
              <LockKeyholeIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {t('settings.roles.lockedRole')}
            </p>
          ) : null}
        </div>
        {role.isOwner || !editable ? null : (
          <Button
            type="button"
            variant="outline"
            aria-expanded={open}
            aria-controls={`${ids}-editor`}
            aria-describedby={`${ids}-name`}
            onClick={onToggle}
            className="shrink-0"
          >
            <span className="max-sm:sr-only">{t('settings.roles.edit')}</span>
            <ChevronDownIcon
              aria-hidden
              className={cn('transition-transform', open && 'rotate-180')}
            />
          </Button>
        )}
      </div>
      <div id={`${ids}-editor`}>
        {open && editable ? (
          <PermissionEditor role={role} access={access} groups={groups} onDone={onToggle} />
        ) : null}
      </div>
    </li>
  )
}

export function RolesSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const roles = useQuery({
    ...trpc.role.list.queryOptions(),
    enabled: context ? isSectionVisible(context, 'roles') : false,
  })
  const [open, setOpen] = useState<string | null>(null)
  if (!context) return null
  const groups = visiblePermissionGroups(context.capabilities)
  return (
    <SectionPage businessId={businessId} section="roles">
      <p className="flex items-start gap-2.5 rounded-xl bg-muted/60 px-4 py-3 text-sm leading-relaxed">
        <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
        {t('settings.roles.note')}
      </p>
      {roles.isPending ? (
        <SectionSkeleton cards={3} />
      ) : roles.isError ? (
        <LoadError error={roles.error} onRetry={() => void roles.refetch()} />
      ) : (
        <ul className="space-y-3">
          {roles.data.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              access={context}
              groups={groups}
              open={open === role.id}
              onToggle={() => setOpen((current) => (current === role.id ? null : role.id))}
            />
          ))}
        </ul>
      )}
    </SectionPage>
  )
}
