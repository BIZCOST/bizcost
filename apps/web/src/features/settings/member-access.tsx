'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { MemberPermissionsDto } from '@bizcost/contracts'
import type { SensitiveDataSwitch } from '@bizcost/modules'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CrownIcon,
  InfoIcon,
  LockKeyholeIcon,
  RotateCcwIcon,
  UserRoundXIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Avatar } from '@/components/app/avatar'
import { FormAlert } from '@/components/form/form-alert'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import {
  offeredSensitiveSwitches,
  permissionLabelKey,
  sensitiveLabelKey,
  visiblePermissionGroups,
  type PermissionGroup,
} from './permission-groups'
import { PermissionSwitches } from './permission-switches'
import { changeCount, changedSwitches, overridesFor } from './member-overrides'
import { canGrantKey } from './role-labels'
import { useRoleName } from './role-picker'
import { can, isSectionVisible, sectionPath } from './sections'
import { NoAccess } from './settings-shell'

// A member's own permissions (M2 Step 7, D-191; deferred from M1 by D-084): Settings → Team → a
// member → Permissions. What their role gives them, with switches to let this one person do more or
// less; each switch that differs from the role says "Added" or "Removed". The same rules as the Roles
// editor: a permission comes with what it needs (costs, supplier prices and margins as one switch), and
// nobody gives access they don't have. Not the owner's (they can do everything) and not one's own.
// The changes are saved whole (member.updatePermissions), with the member's permissions version.
// "N changes from their role" names each switch that differs, and leads to it (D-200).

function Editor({
  data,
  groups,
  sensitive,
}: {
  data: MemberPermissionsDto
  groups: readonly PermissionGroup[]
  sensitive: readonly SensitiveDataSwitch[]
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const update = useMutation(trpc.member.updatePermissions.mutationOptions())
  const form = useRef<HTMLFormElement>(null)
  // What the member may do now (a key without what it needs grants nothing, so it starts off).
  const [saved, setSaved] = useState(() => new Set(data.effectiveKeys))
  const [keys, setKeys] = useState(() => new Set(data.effectiveKeys))
  const [conflict, setConflict] = useState(false)
  // Their access moved on (saved here, or by someone else after a conflict): the latest is shown.
  const [version, setVersion] = useState(data.version)
  if (version !== data.version) {
    setVersion(data.version)
    setSaved(new Set(data.effectiveKeys))
    setKeys(new Set(data.effectiveKeys))
  }
  const roleKeys = new Set(data.roleKeys)
  const dirty = keys.size !== saved.size || [...keys].some((key) => !saved.has(key))
  const changes = changeCount(keys, roleKeys, sensitive)
  const changed = changedSwitches(keys, roleKeys, sensitive, groups)
  /** Brings a changed switch into view and gives it the focus. */
  const goTo = (switchKey: string) => {
    const row = form.current?.querySelector<HTMLElement>(
      `[data-permission-key="${CSS.escape(switchKey)}"]`,
    )
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector<HTMLElement>('[role="switch"]')?.focus({ preventScroll: true })
  }
  const editable = data.editable
  const name = isolate(data.displayName)
  const locked =
    editable &&
    (groups.some((group) => group.keys.some((key) => !canGrantKey(context!, key))) ||
      sensitive.some((item) => item.keys.some((key) => !canGrantKey(context!, key))))

  async function save(): Promise<boolean> {
    setConflict(false)
    try {
      const result = await update.mutateAsync({
        memberId: data.memberId,
        version: data.version,
        overrides: overridesFor(keys, data.roleKeys),
      })
      setSaved(new Set(result.effectiveKeys))
      queryClient.setQueryData(
        trpc.member.permissions.queryKey({ memberId: data.memberId }),
        result,
      )
      void queryClient.invalidateQueries({ queryKey: trpc.member.list.queryKey() })
      toast.success(t('settings.memberAccess.saved', { name }))
      return true
    } catch (error) {
      if (apiErrorCode(error) === 'conflict') {
        setConflict(true)
        await queryClient.invalidateQueries({
          queryKey: trpc.member.permissions.queryKey({ memberId: data.memberId }),
        })
        return false
      }
      toast.error(t(apiErrorKey(error)))
      return false
    }
  }

  useUnsavedChanges({ dirty: editable && dirty, save })

  return (
    <form
      ref={form}
      method="post"
      noValidate
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      {editable ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3">
          <p className="text-sm font-medium" aria-live="polite" data-changes={changes}>
            {changes === 0
              ? t('settings.memberAccess.same')
              : t('settings.memberAccess.changes', { count: changes })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="bg-card"
            disabled={changes === 0 || update.isPending}
            onClick={() => setKeys(new Set(data.roleKeys))}
          >
            <RotateCcwIcon aria-hidden />
            {t('settings.memberAccess.reset')}
          </Button>
          {changed.length > 0 ? (
            <ul
              className="flex w-full flex-wrap gap-2"
              aria-label={t('settings.memberAccess.changedList')}
              data-changed-switches
            >
              {changed.map((item) => (
                <li key={item.switchKey}>
                  <button
                    type="button"
                    onClick={() => goTo(item.switchKey)}
                    className="inline-flex min-h-9 items-center gap-2 rounded-full border bg-card px-3 py-1 text-start text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
                  >
                    <Badge tone={item.change === 'added' ? 'primary' : 'warning'}>
                      {t(`settings.memberAccess.${item.change}`)}
                    </Badge>
                    {term(
                      item.sensitive
                        ? sensitiveLabelKey(item.sensitive)
                        : permissionLabelKey(item.permission!),
                      context?.terminologyProfile,
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {editable ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          {t('settings.memberAccess.legend')}
        </p>
      ) : null}
      {locked ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <LockKeyholeIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('settings.memberAccess.lockedNote')}
        </p>
      ) : null}
      <div className="space-y-5 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5">
        <PermissionSwitches
          groups={groups}
          sensitive={sensitive}
          keys={keys}
          onChange={setKeys}
          canGrant={(key) => editable && context !== undefined && canGrantKey(context, key)}
          disabled={!editable || update.isPending}
          baseline={roleKeys}
          profile={context?.terminologyProfile}
        />
      </div>
      {conflict ? <FormAlert tone="error">{t('settings.memberAccess.conflict')}</FormAlert> : null}
      {editable ? (
        <>
          <p className="text-sm text-muted-foreground">{t('settings.memberAccess.roleNote')}</p>
          {/* Kept in sight while there is something to save. */}
          <div
            className={cn(
              'flex flex-wrap items-center justify-end gap-2',
              dirty &&
                'sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur md:bottom-4',
            )}
          >
            <Button
              type="button"
              variant="ghost"
              disabled={!dirty || update.isPending}
              onClick={() => setKeys(new Set(saved))}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={!dirty || update.isPending} className="min-w-28">
              {update.isPending ? t('status.saving') : t('settings.memberAccess.save')}
            </Button>
          </div>
        </>
      ) : null}
    </form>
  )
}

export function MemberAccess({ businessId, memberId }: { businessId: string; memberId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const roleName = useRoleName()
  const { data: context } = useBusinessContext()
  const visible =
    context !== undefined &&
    isSectionVisible(context, 'members') &&
    can(context, 'settings.roles.manage')
  const access = useQuery({
    ...trpc.member.permissions.queryOptions({ memberId }),
    enabled: visible,
    retry: (count, error) => apiErrorCode(error) !== 'not_found' && count < 2,
  })
  if (!context) return null
  if (!visible) return <NoAccess businessId={businessId} />
  const teamHref = sectionPath(businessId, 'members')
  const back = (
    <Link
      href={teamHref}
      className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
      {t('settings.memberAccess.back')}
    </Link>
  )
  if (access.isError && apiErrorCode(access.error) === 'not_found') {
    return (
      <StatePanel
        icon={UserRoundXIcon}
        title={t('settings.memberAccess.notFound')}
        body={t('settings.memberAccess.notFoundBody')}
        documentTitle={`${t('settings.memberAccess.notFound')} · ${t('appName')}`}
      >
        <Button asChild variant="outline" size="lg">
          <Link href={teamHref}>{t('settings.memberAccess.back')}</Link>
        </Button>
      </StatePanel>
    )
  }
  const moduleIds = context.modules.map((m) => m.id)
  const groups = visiblePermissionGroups(context.capabilities, moduleIds)
  const sensitive = offeredSensitiveSwitches(moduleIds)
  const data = access.data
  const role = data ? roleName({ templateKey: data.roleTemplateKey, name: data.roleName }) : ''
  return (
    <div>
      {back}
      {access.isPending ? (
        <SectionSkeleton cards={2} />
      ) : access.isError ? (
        <LoadError error={access.error} onRetry={() => void access.refetch()} />
      ) : data ? (
        <>
          <header className="mb-6 flex items-start gap-4">
            <Avatar name={data.displayName} className="size-12 text-base" />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight break-words">
                {t('settings.memberAccess.title', { name: isolate(data.displayName) })}
              </h1>
              <p className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge tone={data.isOwner ? 'primary' : 'neutral'}>
                  {data.isOwner ? <CrownIcon aria-hidden /> : null}
                  <span dir="auto">{t('settings.memberAccess.ownRole', { role })}</span>
                </Badge>
              </p>
              {data.isOwner ? null : (
                <p className="mt-2 max-w-2xl text-muted-foreground">
                  {t('settings.memberAccess.intro', {
                    name: isolate(data.displayName),
                    role: isolate(role),
                  })}
                </p>
              )}
            </div>
          </header>
          {data.isOwner ? (
            <FormAlert tone="info">{t('settings.memberAccess.owner')}</FormAlert>
          ) : (
            <>
              {data.isYou ? (
                <FormAlert tone="info" className="mb-5">
                  {t('settings.memberAccess.yours')}
                </FormAlert>
              ) : !data.editable ? (
                <FormAlert tone="info" className="mb-5">
                  {t('settings.memberAccess.locked')}
                </FormAlert>
              ) : null}
              <Editor key={data.memberId} data={data} groups={groups} sensitive={sensitive} />
            </>
          )}
        </>
      ) : null}
    </div>
  )
}
