'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  LOCATION_NAME_MAX_LENGTH,
  withoutControlCharacters,
  type LocationDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  EllipsisVerticalIcon,
  MapPinIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { isolate, useMessage } from '@/components/form/use-message'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useBusinessContext } from '@/lib/trpc/client'
import { LoadError, SectionSkeleton } from './query-state'
import { isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Branches (ROADMAP.md Step 6): only for a business with more than one location
// (capability multi_location; the API refuses the rest). The main branch is the default one: it can be
// renamed but not removed. Removing a branch hides it; nothing recorded there is deleted.

const nameSchema = z.object({
  name: z
    .string()
    .check(
      z.overwrite(withoutControlCharacters),
      z.trim(),
      z.minLength(1, { error: 'settings.locations.nameRequired' }),
      z.maxLength(LOCATION_NAME_MAX_LENGTH, { error: 'settings.locations.nameTooLong' }),
    ),
})
type NameForm = z.input<typeof nameSchema>

function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  submitLabel,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  initial: string
  submitLabel: string
  /** Saves the name; returns an error key to show, or null when done. */
  onSubmit: (name: string) => Promise<I18nKey | null>
}) {
  const { t } = useTranslation()
  const message = useMessage()
  const [error, setError] = useState<I18nKey | null>(null)
  const form = useForm<NameForm>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: initial },
  })
  const busy = form.formState.isSubmitting
  const submit = form.handleSubmit(async ({ name }) => {
    setError(null)
    const failed = await onSubmit(name)
    if (failed) setError(failed)
  })
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent closeLabel={t('actions.close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form method="post" noValidate onSubmit={submit} className="space-y-5">
          {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
          <TextField
            label={t('settings.locations.name')}
            dir="auto"
            autoComplete="off"
            autoFocus
            error={message(form.formState.errors.name?.message, {
              count: LOCATION_NAME_MAX_LENGTH,
            })}
            {...form.register('name')}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('status.saving') : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type Editing = { kind: 'add'; id: string } | { kind: 'rename'; location: LocationDto }

export function LocationsSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const list = useQuery({
    ...trpc.location.list.queryOptions(),
    enabled: context ? isSectionVisible(context, 'locations') : false,
  })
  const create = useMutation(trpc.location.create.mutationOptions())
  const rename = useMutation(trpc.location.rename.mutationOptions())
  const setDefault = useMutation(trpc.location.setDefault.mutationOptions())
  const remove = useMutation(trpc.location.remove.mutationOptions())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<LocationDto | null>(null)
  const [removeError, setRemoveError] = useState<I18nKey | null>(null)
  const listKey = trpc.location.list.queryKey()
  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey })

  async function save(name: string): Promise<I18nKey | null> {
    if (!editing) return null
    try {
      if (editing.kind === 'add') {
        await create.mutateAsync({ id: editing.id, name })
        toast.success(t('settings.locations.added', { name: isolate(name) }))
      } else {
        await rename.mutateAsync({
          id: editing.location.id,
          name,
          version: editing.location.version,
        })
        toast.success(t('settings.locations.renamed'))
      }
      await refresh()
      setEditing(null)
      return null
    } catch (error) {
      await refresh()
      return apiErrorKey(error)
    }
  }

  async function makeDefault(location: LocationDto) {
    try {
      queryClient.setQueryData(listKey, await setDefault.mutateAsync({ id: location.id }))
      toast.success(t('settings.locations.madeDefault', { name: isolate(location.name) }))
    } catch (error) {
      toast.error(t(apiErrorKey(error)))
      await refresh()
    }
  }

  async function confirmRemove() {
    if (!removing) return
    setRemoveError(null)
    try {
      await remove.mutateAsync({ id: removing.id })
      toast.success(t('settings.locations.removed', { name: isolate(removing.name) }))
      setRemoving(null)
    } catch (error) {
      setRemoveError(apiErrorKey(error))
    } finally {
      await refresh()
    }
  }

  return (
    <SectionPage
      businessId={businessId}
      section="locations"
      actions={
        <Button onClick={() => setEditing({ kind: 'add', id: newId() })}>
          <PlusIcon aria-hidden />
          {t('settings.locations.add')}
        </Button>
      }
    >
      {list.isPending ? (
        <SectionSkeleton cards={1} />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <ul
          aria-label={t('settings.locations.title')}
          className="divide-y rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
        >
          {list.data.map((location) => (
            <li
              key={location.id}
              className="flex items-center gap-3 px-4 py-3 sm:px-5"
              data-location={location.name}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
                <MapPinIcon aria-hidden className="size-5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span dir="auto" className="min-w-0 truncate font-medium">
                  {location.name}
                </span>
                {location.isDefault ? (
                  <Badge tone="primary">
                    <StarIcon aria-hidden />
                    {t('settings.locations.default')}
                  </Badge>
                ) : null}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('settings.locations.actions', { name: isolate(location.name) })}
                  >
                    <EllipsisVerticalIcon aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    className="py-2"
                    onSelect={() => setEditing({ kind: 'rename', location })}
                  >
                    <PencilIcon aria-hidden />
                    {t('settings.locations.rename')}
                  </DropdownMenuItem>
                  {!location.isDefault ? (
                    <>
                      <DropdownMenuItem
                        className="py-2"
                        onSelect={() => void makeDefault(location)}
                      >
                        <StarIcon aria-hidden />
                        {t('settings.locations.makeDefault')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        className="py-2"
                        onSelect={() => {
                          setRemoveError(null)
                          setRemoving(location)
                        }}
                      >
                        <Trash2Icon aria-hidden />
                        {t('settings.locations.remove')}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t('settings.locations.note')}
      </p>

      {editing ? (
        <NameDialog
          key={editing.kind === 'add' ? editing.id : editing.location.id}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={
            editing.kind === 'add'
              ? t('settings.locations.addTitle')
              : t('settings.locations.renameTitle')
          }
          description={editing.kind === 'add' ? t('settings.locations.addDescription') : undefined}
          initial={editing.kind === 'add' ? '' : editing.location.name}
          submitLabel={editing.kind === 'add' ? t('settings.locations.add') : t('actions.save')}
          onSubmit={save}
        />
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && !remove.isPending && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t('settings.locations.removeTitle', { name: isolate(removing?.name ?? '') })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('settings.locations.removeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? <FormAlert tone="error">{t(removeError)}</FormAlert> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t('actions.cancel')}</AlertDialogCancel>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => void confirmRemove()}
            >
              {remove.isPending ? t('status.removing') : t('settings.locations.remove')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionPage>
  )
}
