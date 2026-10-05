'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  SALES_CHANNEL_NAME_MAX_LENGTH,
  withoutControlCharacters,
  type SalesChannelDto,
} from '@bizcost/contracts'
import {
  newId,
  SALES_CHANNEL_KINDS,
  SALES_CHANNEL_PRESETS,
  type SalesChannelKind,
  type SalesChannelPreset,
} from '@bizcost/domain'
import { nameKey } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BikeIcon,
  EllipsisVerticalIcon,
  GlobeIcon,
  MessageCircleIcon,
  PencilIcon,
  PlusIcon,
  ShoppingBagIcon,
  StoreIcon,
  TagIcon,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { readPercent, withLatinDigits } from '@/features/catalog/numbers'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { invalidateProfit } from '@/features/reports/refresh'
import { isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Sales channels (M3 Step 2; D-226): every way the business sells (its shop, WhatsApp and
// phone, its website, delivery apps, marketplaces), seeded from Smart Setup. "Add a channel" offers
// the delivery apps and marketplaces UAE businesses sell through (a preset is only a name and a kind),
// or any name. A channel is archived, never deleted (its sales keep it), and the last active one stays.
// "What does the app keep from each sale?" (the commission in the contract, Q8) is a cost: it is shown
// and typed only with the costs switch (D-187), and a member without it changes a channel without ever
// sending it (the API keeps it).

/** The kinds that keep a part of each sale (a commission, D-223). */
const KEEPS_A_PART: ReadonlySet<SalesChannelKind> = new Set(['delivery_app', 'marketplace'])

const KIND_ICONS: Readonly<Record<SalesChannelKind, LucideIcon>> = {
  shop: StoreIcon,
  messages: MessageCircleIcon,
  website: GlobeIcon,
  delivery_app: BikeIcon,
  marketplace: ShoppingBagIcon,
  other: TagIcon,
}

interface ChannelDraft {
  name: string
  kind: SalesChannelKind
  /** '' for none. */
  feePercent: string
}

type Editing = { kind: 'add'; id: string } | { kind: 'edit'; channel: SalesChannelDto }

function ChannelDialog({
  editing,
  seesCosts,
  onClose,
  onSaved,
}: {
  editing: Editing
  /** The member sees costs: the commission is shown and sent. */
  seesCosts: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const create = useMutation(trpc.channel.create.mutationOptions())
  const update = useMutation(trpc.channel.update.mutationOptions())
  const channel = editing.kind === 'edit' ? editing.channel : undefined
  const [initial] = useState<ChannelDraft>(() => ({
    name: channel?.name ?? '',
    kind: channel?.kind ?? 'delivery_app',
    feePercent: typeof channel?.feePercent === 'string' ? channel.feePercent : '',
  }))
  const [draft, setDraft] = useState<ChannelDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<I18nKey | null>(null)
  const busy = create.isPending || update.isPending
  const name = withoutControlCharacters(draft.name).trim()
  const nameError: I18nKey | null =
    name === ''
      ? 'settings.channels.nameRequired'
      : name.length > SALES_CHANNEL_NAME_MAX_LENGTH
        ? 'settings.channels.nameTooLong'
        : null
  const keepsAPart = KEEPS_A_PART.has(draft.kind)
  const fee =
    keepsAPart && seesCosts && draft.feePercent.trim() !== '' ? readPercent(draft.feePercent) : null
  const feeError = fee && !fee.ok ? fee.error : null
  const dirty =
    draft.name !== initial.name ||
    draft.kind !== initial.kind ||
    draft.feePercent !== initial.feePercent

  const presetName = (key: SalesChannelPreset) => t(`settings.channels.presets.${key}`)
  const pickPreset = (key: SalesChannelPreset, kind: SalesChannelKind) =>
    setDraft((d) => ({ ...d, name: presetName(key), kind }))

  async function save(): Promise<boolean> {
    setSubmitted(true)
    setError(null)
    if (nameError || feeError) return false
    // The commission: only a member who sees costs sends it (null clears it); a kind that keeps
    // nothing has none. Without the costs switch it is left out, and the API keeps it.
    const feePercent = seesCosts ? (keepsAPart && fee?.ok ? fee.value : null) : undefined
    try {
      if (editing.kind === 'add') {
        await create.mutateAsync({
          id: editing.id,
          name,
          kind: draft.kind,
          ...(feePercent === undefined ? {} : { feePercent }),
        })
        toast.success(t('settings.channels.added', { name: isolate(name) }))
      } else {
        await update.mutateAsync({
          id: editing.channel.id,
          version: editing.channel.version,
          name,
          kind: draft.kind,
          ...(feePercent === undefined ? {} : { feePercent }),
        })
        toast.success(t('settings.channels.saved'))
      }
      await onSaved()
      return true
    } catch (caught) {
      setError(
        apiErrorCode(caught) === 'conflict' ? 'settings.channels.conflict' : apiErrorKey(caught),
      )
      return false
    }
  }

  const guard = useUnsavedChanges({ dirty, save, close: onClose })
  const leave = () => guard.requestLeave(onClose)

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && leave()}>
      <DialogContent
        closeLabel={t('actions.close')}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {editing.kind === 'add'
              ? t('settings.channels.addTitle')
              : t('settings.channels.editTitle')}
          </DialogTitle>
          <DialogDescription>
            {editing.kind === 'add'
              ? t('settings.channels.addDescription')
              : t('settings.channels.editDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          method="post"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          className="space-y-5"
        >
          {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
          {editing.kind === 'add' ? (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">
                {t('settings.channels.presetsLabel')}
              </legend>
              <div className="flex flex-wrap gap-2" data-channel-presets>
                {SALES_CHANNEL_PRESETS.map((preset) => {
                  const chosen = nameKey(draft.name) === nameKey(presetName(preset.key))
                  return (
                    <button
                      key={preset.key}
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => pickPreset(preset.key, preset.kind)}
                      className={cn(
                        'inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring',
                        chosen ? 'border-primary bg-accent text-primary' : 'bg-card hover:bg-muted',
                      )}
                    >
                      <bdi>{presetName(preset.key)}</bdi>
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ) : null}
          <TextField
            label={t('settings.channels.name')}
            dir="auto"
            autoComplete="off"
            value={draft.name}
            onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
            error={
              submitted && nameError
                ? t(nameError, { count: SALES_CHANNEL_NAME_MAX_LENGTH })
                : undefined
            }
          />
          <TextField
            label={t('settings.channels.kind')}
            render={(a11y) => (
              <NativeSelect
                {...a11y}
                value={draft.kind}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, kind: event.target.value as SalesChannelKind }))
                }
              >
                {SALES_CHANNEL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`settings.channels.kinds.${kind}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          />
          {keepsAPart && seesCosts ? (
            <TextField
              label={t('settings.channels.fee')}
              error={feeError ? t(feeError.key, feeError.values) : undefined}
              hint={(hintId) => (
                <p id={hintId} className="text-sm text-muted-foreground">
                  {t('settings.channels.feeHint')}
                </p>
              )}
              render={(a11y) => (
                <div className="flex max-w-48">
                  <Input
                    {...a11y}
                    inputMode="decimal"
                    dir="ltr"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('purchasing.editor.percentPlaceholder')}
                    value={draft.feePercent}
                    onChange={(event) =>
                      setDraft((d) => ({ ...d, feePercent: event.target.value }))
                    }
                    onBlur={() =>
                      setDraft((d) => ({ ...d, feePercent: withLatinDigits(d.feePercent) }))
                    }
                    className="min-w-0 rounded-e-none tabular-nums rtl:text-end"
                  />
                  <span
                    aria-hidden
                    className="flex h-11 shrink-0 items-center rounded-e-lg border border-s-0 border-input bg-muted px-2.5 text-sm font-medium text-muted-foreground"
                  >
                    %
                  </span>
                </div>
              )}
            />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={leave}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? t('status.saving')
                : editing.kind === 'add'
                  ? t('settings.channels.add')
                  : t('actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ChannelRow({
  channel,
  seesCosts,
  onEdit,
  onArchive,
}: {
  channel: SalesChannelDto
  seesCosts: boolean
  onEdit: () => void
  onArchive: () => void
}) {
  const { t } = useTranslation()
  const Icon = KIND_ICONS[channel.kind]
  const archived = channel.archivedAt !== null
  return (
    <li className="flex items-center gap-3 px-4 py-3 sm:px-5" data-channel={channel.name}>
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          archived ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span dir="auto" className="min-w-0 font-medium break-words">
            {channel.name}
          </span>
          {archived ? <Badge tone="neutral">{t('settings.channels.archivedBadge')}</Badge> : null}
        </p>
        <p className="text-sm text-muted-foreground">
          {t(`settings.channels.kinds.${channel.kind}`)}
          {KEEPS_A_PART.has(channel.kind) && seesCosts ? (
            <>
              {' · '}
              {typeof channel.feePercent === 'string' ? (
                <span data-channel-fee>
                  {t('settings.channels.keeps', { percent: channel.feePercent })}
                </span>
              ) : (
                t('settings.channels.noFee')
              )}
            </>
          ) : null}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('settings.channels.actions', { name: isolate(channel.name) })}
          >
            <EllipsisVerticalIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {archived ? null : (
            <DropdownMenuItem className="py-2" onSelect={onEdit}>
              <PencilIcon aria-hidden />
              {t('settings.channels.edit')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="py-2" onSelect={onArchive}>
            {archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
            {archived ? t('settings.channels.unarchive') : t('settings.channels.archive')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export function ChannelsSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const visible = context ? isSectionVisible(context, 'channels') : false
  const list = useQuery({ ...trpc.channel.list.queryOptions({ status: 'all' }), enabled: visible })
  const archive = useMutation(trpc.channel.archive.mutationOptions())
  const unarchive = useMutation(trpc.channel.unarchive.mutationOptions())
  const [editing, setEditing] = useState<Editing | null>(null)
  const seesCosts = context?.visibleCategories.includes('cost') === true
  // A channel's name, kind or commission changes real profit by channel and its fees (D-212).
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.channel.list.pathKey() }),
      invalidateProfit(queryClient, trpc),
    ])

  async function toggleArchive(channel: SalesChannelDto) {
    try {
      if (channel.archivedAt === null) {
        await archive.mutateAsync({ id: channel.id })
        toast.success(t('settings.channels.archived', { name: isolate(channel.name) }))
      } else {
        await unarchive.mutateAsync({ id: channel.id })
        toast.success(t('settings.channels.unarchived', { name: isolate(channel.name) }))
      }
    } catch (caught) {
      toast.error(t(apiErrorKey(caught)))
    } finally {
      await refresh()
    }
  }

  const items = list.data?.data.items ?? []
  const active = items.filter((channel) => channel.archivedAt === null)
  const archived = items.filter((channel) => channel.archivedAt !== null)
  const missingFee =
    seesCosts &&
    active.some((channel) => KEEPS_A_PART.has(channel.kind) && channel.feePercent === null)

  return (
    <SectionPage
      businessId={businessId}
      section="channels"
      actions={
        <Button onClick={() => setEditing({ kind: 'add', id: newId() })}>
          <PlusIcon aria-hidden />
          {t('settings.channels.add')}
        </Button>
      }
    >
      {list.isPending ? (
        <SectionSkeleton cards={1} />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <ul
            aria-label={t('settings.channels.title')}
            className="divide-y rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {active.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                seesCosts={seesCosts}
                onEdit={() => setEditing({ kind: 'edit', channel })}
                onArchive={() => void toggleArchive(channel)}
              />
            ))}
          </ul>
          {missingFee ? (
            <FormAlert tone="info">{t('settings.channels.missingFee')}</FormAlert>
          ) : null}
          {archived.length > 0 ? (
            <section aria-labelledby="archived-channels" className="space-y-2">
              <h2 id="archived-channels" className="px-1 font-semibold">
                {t('settings.channels.archivedTitle')}
              </h2>
              <ul className="divide-y rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]">
                {archived.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    seesCosts={seesCosts}
                    onEdit={() => setEditing({ kind: 'edit', channel })}
                    onArchive={() => void toggleArchive(channel)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      <p className="text-sm leading-relaxed text-muted-foreground">{t('settings.channels.note')}</p>
      {editing ? (
        <ChannelDialog
          key={editing.kind === 'add' ? editing.id : editing.channel.id}
          editing={editing}
          seesCosts={seesCosts}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh()
            setEditing(null)
          }}
        />
      ) : null}
    </SectionPage>
  )
}
