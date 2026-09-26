'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { BusinessItemDto, CustomizationDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import {
  businessStateOf,
  CAPABILITIES,
  isCapabilityKey,
  JOBS_ITEM,
  moduleDescriptionKey,
  moduleById,
  moduleNameKey,
  setupItemNameKey,
  toggleBusinessItem,
  type Capabilities,
  type ModuleId,
  type SetupItem,
  type StatementKey,
} from '@bizcost/modules'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon, EyeOffIcon, InfoIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react'
import Link from 'next/link'
import { useId, useState, type ReactNode } from 'react'
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
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { JOBS_ICON, moduleIcon, STATEMENT_ICONS } from '@/features/setup/icons'
import { Chips, Group, ShowHide } from '@/features/setup/review-parts'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { isModuleId } from './module-names'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { can, isSectionVisible, sectionPath } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Customize BizCost (ROADMAP.md Step 6; docs/PRODUCT.md §5): the business's sections and
// what it says about itself, switched with the same rules as the Smart Setup review (toggleBusinessItem
// from @bizcost/modules previews what else changes; the server applies the same rules and saves).
// Turning something off hides it and never deletes data; a switch that turns off other sections asks
// first. VAT is switched in the business profile (a legal fact with its TRN), not here. Planned
// sections are shown the way the review shows them: saved now, appearing by themselves when ready.

/** The capabilities switched here, as the review's statements (VAT is in the business profile). */
const SWITCHED_STATEMENTS: readonly StatementKey[] = [
  'has_team',
  'multi_location',
  'keeps_stock',
  'uses_machines',
  'sells_via_pos',
]

function itemId(item: SetupItem | BusinessItemDto): string {
  return item.kind === 'module' ? item.id : `capability:${item.key}`
}

/** A server item as a switch of the review rules (unknown ids are dropped). */
function toSetupItem(item: BusinessItemDto): SetupItem | null {
  if (item.kind === 'module') return isModuleId(item.id) ? { kind: 'module', id: item.id } : null
  return isCapabilityKey(item.key) ? { kind: 'capability', key: item.key } : null
}

function toDto(item: SetupItem): BusinessItemDto {
  return item.kind === 'module'
    ? { kind: 'module', id: item.id }
    : { kind: 'capability', key: item.key }
}

/** The customization as the review rules' state (every capability of the registry). */
function stateOf(data: CustomizationDto) {
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((c) => [c.key, data.capabilities[c.key] === true]),
  ) as unknown as Capabilities
  return businessStateOf({
    enabledModules: data.modules.filter((m) => m.enabled).map((m) => m.id),
    capabilities,
  })
}

interface Row {
  readonly item: SetupItem
  readonly nameKey: I18nKey
  readonly textKey: I18nKey
  readonly enabled: boolean
  readonly planned: boolean
  /** Requires VAT while the business is not VAT registered. */
  readonly needsVat: boolean
}

/** The last switch flipped and what changed with it ("Also turned on:" / "Also turned off:"). */
interface Effect {
  readonly id: string
  readonly turnedOn: readonly SetupItem[]
  readonly turnedOff: readonly SetupItem[]
}

/** A switch that turns off other sections, waiting for "Turn off". */
interface Pending {
  readonly item: SetupItem
  readonly turnedOff: readonly SetupItem[]
}

/** Capabilities a module requires (its manifest). */
function requiresOf(id: ModuleId): readonly string[] {
  return moduleById(id)?.requiresCapabilities ?? []
}

/** Groups of rows, from a snapshot (kept while only modules change, so a row stays in place). */
function groupsOf(layout: CustomizationDto, current: CustomizationDto, jobsOffered: boolean) {
  const enabledNow = new Set(current.modules.filter((m) => m.enabled).map((m) => m.id))
  const vat = current.capabilities.vat_registered === true
  // Offered when the business has what the section needs; VAT sections also without VAT, with a note.
  const requiredOn = (id: ModuleId, data: CustomizationDto) =>
    requiresOf(id).every((cap) => cap === 'vat_registered' || data.capabilities[cap] === true)
  const row = (id: ModuleId): Row => ({
    item: { kind: 'module', id },
    nameKey: moduleNameKey(id),
    textKey: moduleDescriptionKey(id) ?? (`setup.reason.${id}.default` as I18nKey),
    enabled: enabledNow.has(id),
    planned: current.modules.find((m) => m.id === id)?.availability !== 'released',
    needsVat: requiresOf(id).includes('vat_registered') && !vat,
  })
  const jobsRow: Row = {
    item: JOBS_ITEM,
    nameKey: 'setup.jobs.name',
    textKey: 'setup.jobs.desc',
    enabled: current.capabilities.jobs_and_tasks === true,
    planned: true,
    needsVat: false,
  }
  const chosen: Row[] = []
  const basics: Row[] = []
  const more: Row[] = []
  if (layout.capabilities.jobs_and_tasks === true) chosen.push(jobsRow)
  for (const module of layout.modules) {
    if (!isModuleId(module.id)) continue
    if (module.enabled) (module.kind === 'optional' ? chosen : basics).push(row(module.id))
    else if (requiredOn(module.id, layout)) more.push(row(module.id))
  }
  if (layout.capabilities.jobs_and_tasks !== true && jobsOffered) more.push(jobsRow)
  return { chosen, basics, more }
}

export function CustomizeSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const ids = useId()
  const { data: context } = useBusinessContext()
  const customization = useQuery({
    ...trpc.business.customization.queryOptions(),
    enabled: context ? isSectionVisible(context, 'modules') : false,
  })
  const customize = useMutation(trpc.business.customize.mutationOptions())
  const [layout, setLayout] = useState<CustomizationDto | null>(null)
  const [effect, setEffect] = useState<Effect | null>(null)
  const [blocked, setBlocked] = useState<{ id: string; key: I18nKey } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [basicsOpen, setBasicsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const key = trpc.business.customization.queryKey()

  if (!context) return null
  const profile = context.terminologyProfile
  const tt = (k: I18nKey) => term(k, profile)
  const nameOf = (item: SetupItem) => tt(setupItemNameKey(item))
  const canViewBusiness = can(context, 'settings.business.view')

  async function apply(item: SetupItem, enabled: boolean) {
    const before = customization.data
    if (!before) return
    setBlocked(null)
    try {
      const result = await customize.mutateAsync({ item: toDto(item), enabled })
      const turnedOn = result.turnedOn.map(toSetupItem).filter((i) => i !== null)
      const turnedOff = result.turnedOff.map(toSetupItem).filter((i) => i !== null)
      const capabilityChanged = [item, ...turnedOn, ...turnedOff].some(
        (i) => i.kind === 'capability' && i.key !== 'jobs_and_tasks',
      )
      // Groups are rebuilt when a capability changes; otherwise a flipped row keeps its place.
      setLayout(capabilityChanged ? null : (layout ?? before))
      queryClient.setQueryData(key, result.customization)
      setEffect({ id: itemId(item), turnedOn, turnedOff })
      // The settings menu and other screens follow the capabilities and modules.
      void queryClient.invalidateQueries({ queryKey: trpc.business.context.queryKey() })
      toast.success(t('settings.modules.saved'))
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'team_in_use' || code === 'locations_in_use') {
        setBlocked({ id: itemId(item), key: `errors.${code}` })
        await queryClient.invalidateQueries({ queryKey: key })
        return
      }
      toast.error(t(apiErrorKey(error)))
      await queryClient.invalidateQueries({ queryKey: key })
    }
  }

  function request(item: SetupItem, enabled: boolean) {
    if (!customization.data || customize.isPending) return
    const preview = toggleBusinessItem(stateOf(customization.data), item, enabled)
    if (!preview.ok) {
      setEffect(null)
      setBlocked(
        preview.issue === 'needs_vat'
          ? { id: itemId(item), key: 'settings.modules.needsVat' }
          : { id: itemId(item), key: 'errors.validation' },
      )
      return
    }
    // Turning off something other sections need: say which, and ask first.
    if (!enabled && preview.turnedOff.length > 0) {
      setPending({ item, turnedOff: preview.turnedOff })
      return
    }
    void apply(item, enabled)
  }

  const data = customization.data
  if (!data) {
    return (
      <SectionPage businessId={businessId} section="modules">
        {customization.isError ? (
          <LoadError error={customization.error} onRetry={() => void customization.refetch()} />
        ) : (
          <SectionSkeleton cards={3} />
        )}
      </SectionPage>
    )
  }

  const busyId =
    customize.isPending && customize.variables
      ? itemId(customize.variables.item as BusinessItemDto)
      : null
  const groups = groupsOf(layout ?? data, data, profile !== 'food')
  const rows = [...groups.chosen, ...groups.basics, ...groups.more]
  const allPlanned = rows.length > 0 && rows.every((r) => r.planned)

  function effectsOf(item: SetupItem, extra?: ReactNode) {
    const id = itemId(item)
    const current = effect?.id === id ? effect : null
    return (
      <div aria-live="polite" className="empty:hidden">
        {current && current.turnedOn.length > 0 ? (
          <div className="mt-2.5 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('setup.review.alsoOn')}</p>
            <Chips labels={current.turnedOn.map(nameOf)} />
          </div>
        ) : null}
        {current && current.turnedOff.length > 0 ? (
          <div className="mt-2.5 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('setup.review.alsoOff')}</p>
            <Chips labels={current.turnedOff.map(nameOf)} />
          </div>
        ) : null}
        {blocked?.id === id ? (
          <p role="alert" className="mt-2 text-sm font-medium text-warning">
            {t(blocked.key)}
          </p>
        ) : null}
        {extra}
      </div>
    )
  }

  function vatLink() {
    return canViewBusiness ? (
      <Link
        href={sectionPath(businessId, 'business')}
        className="tap-area mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {t('settings.modules.openProfile')}
        <ArrowRightIcon aria-hidden className="size-3.5 rtl:rotate-180" />
      </Link>
    ) : null
  }

  function moduleRow(row: Row) {
    const id = `${ids}-${itemId(row.item)}`
    const Icon = row.item.kind === 'module' ? moduleIcon(row.item.id) : JOBS_ICON
    return (
      <li
        key={itemId(row.item)}
        className="flex gap-3.5 py-4 first:pt-2 last:pb-1"
        data-item={itemId(row.item)}
      >
        <span
          className={cn(
            'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
            row.enabled ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p id={`${id}-name`} className="leading-snug font-medium">
              {tt(row.nameKey)}
            </p>
            {row.planned && !allPlanned ? (
              <span className="rounded-full bg-accent px-2 py-px text-xs font-medium text-accent-foreground">
                {t('setup.review.soon')}
              </span>
            ) : null}
          </div>
          <p id={`${id}-text`} className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {tt(row.textKey)}
          </p>
          {row.needsVat ? (
            <>
              <p className="mt-1.5 text-sm font-medium text-warning">
                {t('settings.modules.needsVat')}
              </p>
              {vatLink()}
            </>
          ) : null}
          {effectsOf(row.item)}
        </div>
        <Switch
          checked={row.enabled}
          disabled={row.needsVat || customize.isPending}
          aria-busy={busyId === itemId(row.item) || undefined}
          onCheckedChange={(on) => request(row.item, on)}
          aria-labelledby={`${id}-name`}
          aria-describedby={`${id}-text`}
          className="mt-2.5"
        />
      </li>
    )
  }

  function statementRow(key: StatementKey) {
    const item: SetupItem = { kind: 'capability', key }
    const enabled = data?.capabilities[key] === true
    const id = `${ids}-${key}`
    const Icon = STATEMENT_ICONS[key]
    const inUse =
      enabled &&
      ((key === 'has_team' && data?.teamInUse) ||
        (key === 'multi_location' && data?.locationsInUse))
    return (
      <li
        key={key}
        className="flex items-start gap-3.5 py-3.5 first:pt-2 last:pb-1"
        data-item={`capability:${key}`}
      >
        <span
          className={cn(
            'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
            enabled ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p id={`${id}-topic`} className="text-sm text-muted-foreground">
            {t(`setup.cap.${key}.topic`)}
          </p>
          <p id={`${id}-statement`} className="leading-snug font-medium">
            {t(`setup.cap.${key}.${enabled ? 'on' : 'off'}`)}
          </p>
          {inUse ? (
            <p id={`${id}-in-use`} className="mt-1.5 text-sm text-muted-foreground">
              {key === 'has_team'
                ? t('settings.modules.teamInUse')
                : t('settings.modules.locationsInUse')}
            </p>
          ) : null}
          {effectsOf(item)}
        </div>
        <Switch
          checked={enabled}
          disabled={Boolean(inUse) || customize.isPending}
          onCheckedChange={(on) => request(item, on)}
          aria-labelledby={`${id}-topic`}
          aria-describedby={inUse ? `${id}-statement ${id}-in-use` : `${id}-statement`}
          className="mt-3"
        />
      </li>
    )
  }

  const vatOn = data.capabilities.vat_registered === true

  return (
    <SectionPage businessId={businessId} section="modules">
      <div className="space-y-3">
        <p className="flex items-start gap-2.5 rounded-xl bg-muted/60 px-4 py-3 text-sm leading-relaxed">
          <EyeOffIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          {t('settings.modules.hideNote')}
        </p>
        {allPlanned ? (
          <FormAlert tone="info" className="rounded-xl bg-card px-4 py-3">
            {t('settings.modules.banner')}
          </FormAlert>
        ) : null}
      </div>

      <Group title={t('setup.review.groups.about')}>
        <ul className="divide-y">
          {SWITCHED_STATEMENTS.map(statementRow)}
          <li
            className="flex items-start gap-3.5 py-3.5 last:pb-1"
            data-item="capability:vat_registered"
          >
            <span
              className={cn(
                'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl',
                vatOn ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              <STATEMENT_ICONS.vat_registered aria-hidden className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground">{t('setup.cap.vat_registered.topic')}</p>
              <p className="leading-snug font-medium">
                {t(`setup.cap.vat_registered.${vatOn ? 'on' : 'off'}`)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('settings.modules.vatInProfile')}
              </p>
              {vatLink()}
            </div>
          </li>
        </ul>
        {data.capabilities.has_team === true ? (
          <p className="mt-4 flex items-start gap-2.5 rounded-xl bg-muted/60 px-3.5 py-3 text-sm leading-relaxed">
            <ShieldCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            {t('setup.review.teamNote')}
          </p>
        ) : null}
      </Group>

      {groups.chosen.length > 0 ? (
        <Group
          title={
            <span className="flex items-center gap-2">
              <SparklesIcon aria-hidden className="size-4 text-primary" />
              {t('settings.modules.groups.chosen')}
            </span>
          }
        >
          <ul className="divide-y">{groups.chosen.map(moduleRow)}</ul>
        </Group>
      ) : null}

      {groups.basics.length > 0 ? (
        <Group
          title={t('setup.review.groups.basics')}
          bodyId={`${ids}-basics`}
          action={
            <ShowHide
              open={basicsOpen}
              controls={`${ids}-basics`}
              onToggle={() => setBasicsOpen((open) => !open)}
            />
          }
        >
          {basicsOpen ? (
            <ul className="divide-y">{groups.basics.map(moduleRow)}</ul>
          ) : (
            <div className="pt-2">
              <Chips labels={groups.basics.filter((r) => r.enabled).map((r) => tt(r.nameKey))} />
            </div>
          )}
        </Group>
      ) : null}

      {groups.more.length > 0 ? (
        <Group
          title={
            <span className="flex items-center gap-2">
              {t('setup.review.groups.more')}
              <span className="rounded-full bg-muted px-2 text-xs leading-5 font-medium text-muted-foreground tabular-nums">
                {groups.more.length}
              </span>
            </span>
          }
          bodyId={`${ids}-more`}
          action={
            <ShowHide
              open={moreOpen}
              controls={`${ids}-more`}
              onToggle={() => setMoreOpen((open) => !open)}
            />
          }
        >
          {moreOpen ? <ul className="divide-y">{groups.more.map(moduleRow)}</ul> : null}
        </Group>
      ) : null}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-warning/10 text-warning">
              <InfoIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {pending
                ? t('settings.modules.confirmTitle', { name: isolate(nameOf(pending.item)) })
                : null}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('settings.modules.confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t('setup.review.alsoOff')}
              </p>
              <Chips labels={pending.turnedOff.map(nameOf)} />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <Button
              onClick={() => {
                const next = pending
                setPending(null)
                if (next) void apply(next.item, false)
              }}
            >
              {t('settings.modules.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionPage>
  )
}
