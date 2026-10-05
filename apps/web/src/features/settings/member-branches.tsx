'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, MemberLocationsDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPinnedIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { can } from './sections'

// "Branches they work in" (M3 Step 2; Q12, D-231): on a member's page, for a business with a team and
// branches, while Sales is served (the plan's D3: a released business sees no change before Release
// A). Every branch by default (those added later too), or only some: a member limited to branches
// sees and enters sales only of those; products and costs stay business-wide. Not the Owner's, not
// one's own, and never beyond the editor's own access or branches (the API refuses the same). Saved
// whole with the member's permissions version (member.updateLocations), which bumps it.

/** Whether the member page shows "Branches they work in" to this member. */
export function showsMemberBranches(context: BusinessContextDto): boolean {
  return (
    context.capabilities.has_team === true &&
    context.capabilities.multi_location === true &&
    context.modules.some((module) => module.id === 'sales') &&
    // The branches' names come from the branch list (settings.locations.manage).
    can(context, 'settings.locations.manage')
  )
}

type Where = 'all' | 'some'

function Editor({ data, name }: { data: MemberLocationsDto; name: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const id = useId()
  const locations = useQuery(trpc.location.list.queryOptions())
  const update = useMutation(trpc.member.updateLocations.mutationOptions())
  const [saved, setSaved] = useState(() => ({
    where: (data.locationIds.length > 0 ? 'some' : 'all') as Where,
    ids: [...data.locationIds].sort(),
  }))
  const [where, setWhere] = useState<Where>(saved.where)
  const [ids, setIds] = useState<string[]>(saved.ids)
  const [error, setError] = useState<I18nKey | null>(null)
  const [version, setVersion] = useState(data.version)
  // Saved here, or changed by someone else (after a conflict): the latest is shown.
  if (version !== data.version) {
    const next = {
      where: (data.locationIds.length > 0 ? 'some' : 'all') as Where,
      ids: [...data.locationIds].sort(),
    }
    setVersion(data.version)
    setSaved(next)
    setWhere(next.where)
    setIds(next.ids)
  }
  const chosen = where === 'all' ? [] : [...ids].sort()
  const dirty = where !== saved.where || (where === 'some' && chosen.join() !== saved.ids.join())
  const editable = data.editable

  async function save(): Promise<boolean> {
    setError(null)
    if (where === 'some' && chosen.length === 0) {
      setError('settings.memberBranches.pickOne')
      return false
    }
    try {
      const result = await update.mutateAsync({
        memberId: data.memberId,
        version: data.version,
        locationIds: chosen,
      })
      queryClient.setQueryData(trpc.member.locations.queryKey({ memberId: data.memberId }), result)
      // Their permissions version moved on: the permissions on this page are read again.
      await queryClient.invalidateQueries({
        queryKey: trpc.member.permissions.queryKey({ memberId: data.memberId }),
      })
      toast.success(t('settings.memberBranches.saved', { name: isolate(name) }))
      return true
    } catch (caught) {
      if (apiErrorCode(caught) === 'conflict') {
        setError('settings.memberBranches.conflict')
        await queryClient.invalidateQueries({
          queryKey: trpc.member.locations.queryKey({ memberId: data.memberId }),
        })
        return false
      }
      setError(apiErrorKey(caught))
      return false
    }
  }

  useUnsavedChanges({ dirty: editable && dirty, save })

  const names = new Map((locations.data ?? []).map((location) => [location.id, location.name]))
  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      className="space-y-3"
    >
      {!editable ? (
        <p className="text-sm text-muted-foreground" data-branches-readonly>
          {data.locationIds.length === 0
            ? t('settings.memberBranches.all')
            : t('settings.memberBranches.only', {
                names: data.locationIds
                  .map((locationId) => isolate(names.get(locationId) ?? '…'))
                  .join(t('settings.memberBranches.separator')),
              })}
        </p>
      ) : locations.isPending ? (
        <SectionSkeleton cards={1} />
      ) : locations.isError ? (
        <LoadError error={locations.error} onRetry={() => void locations.refetch()} />
      ) : (
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('settings.memberBranches.title')}</legend>
          {(['all', 'some'] as const).map((choice) => (
            <label key={choice} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
              <input
                type="radio"
                name={`${id}-where`}
                value={choice}
                checked={where === choice}
                onChange={() => setWhere(choice)}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <span className="min-w-0 text-sm">
                <span className="block font-medium">
                  {t(
                    choice === 'all'
                      ? 'settings.memberBranches.every'
                      : 'settings.memberBranches.some',
                  )}
                </span>
                {choice === 'all' ? (
                  <span className="block text-muted-foreground">
                    {t('settings.memberBranches.everyHint')}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
          {where === 'some' ? (
            <div className="ms-8 space-y-1 rounded-xl border bg-background/60 p-2">
              {(locations.data ?? []).map((location) => {
                const checked = ids.includes(location.id)
                return (
                  <label
                    key={location.id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setIds((current) =>
                          checked
                            ? current.filter((value) => value !== location.id)
                            : [...current, location.id],
                        )
                      }
                      className="size-5 shrink-0 accent-primary"
                    />
                    <span dir="auto" className="min-w-0 text-sm">
                      {location.name}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : null}
        </fieldset>
      )}
      {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
      {editable ? (
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
            onClick={() => {
              setWhere(saved.where)
              setIds(saved.ids)
              setError(null)
            }}
          >
            {t('actions.cancel')}
          </Button>
          <Button type="submit" disabled={!dirty || update.isPending} className="min-w-28">
            {update.isPending ? t('status.saving') : t('settings.memberBranches.save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

/** "Branches they work in" on a member's page (not the Owner's: they work everywhere). */
export function MemberBranches({
  memberId,
  name,
  isYou,
}: {
  memberId: string
  name: string
  isYou: boolean
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const branches = useQuery(trpc.member.locations.queryOptions({ memberId }))
  const data = branches.data
  return (
    <section
      aria-labelledby={`branches-${memberId}`}
      data-member-branches
      className="space-y-3 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
          <MapPinnedIcon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id={`branches-${memberId}`} className="font-semibold">
            {t('settings.memberBranches.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('settings.memberBranches.intro', { name: isolate(name) })}
          </p>
        </div>
      </div>
      {branches.isPending ? (
        <SectionSkeleton cards={1} />
      ) : branches.isError ? (
        <LoadError error={branches.error} onRetry={() => void branches.refetch()} />
      ) : data ? (
        <>
          {isYou ? (
            <FormAlert tone="info">{t('settings.memberBranches.yours')}</FormAlert>
          ) : !data.editable ? (
            <FormAlert tone="info">{t('settings.memberBranches.locked')}</FormAlert>
          ) : null}
          <Editor key={data.memberId} data={data} name={name} />
        </>
      ) : null}
    </section>
  )
}
