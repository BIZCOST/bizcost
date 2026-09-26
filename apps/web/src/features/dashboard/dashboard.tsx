'use client'

import { useMe, useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, DashboardChecklistDto } from '@bizcost/contracts'
import {
  businessSummaryKeys,
  checklistItemIds,
  isRoleTemplateKey,
  type Capabilities,
} from '@bizcost/modules'
import { useQuery } from '@tanstack/react-query'
import { InfoIcon } from 'lucide-react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useRef, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { LogoMark } from '@/components/brand/logo'
import { ModuleGate } from '@/components/shell/module-gate'
import { moduleAccess, shellNav, wayBack } from '@/components/shell/nav'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { can } from '@/features/settings/sections'
import { STATEMENT_ICONS } from '@/features/setup/icons'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { AllSet, Checklist, ChecklistSkeleton } from './checklist'
import { progressOf } from './checklist-steps'
import { useAllSetHidden } from './hidden-all-set'

// The Dashboard in M1 (ROADMAP.md Step 7, docs/PRODUCT.md §9–10): a welcome with the business's name
// and the member's role, the getting-started checklist from real data (only the steps the member can
// act on), and what the setup says about the business (§6.8). No cards for sections that are not
// released yet: they arrive with their modules.

/** What the server knows for the Dashboard's first render (its layout loads it, D-090, D-091). */
interface DashboardServerData {
  /** The checklist, when the member has steps and the API answered. */
  readonly checklist: DashboardChecklistDto | null
  /** Whether this user hid "You're all set" here (the cookie). */
  readonly allSetHidden: boolean
}

const ServerData = createContext<DashboardServerData>({ checklist: null, allSetHidden: false })

/**
 * Hands the server's data to the Dashboard ((home)/layout.tsx), for the page and its loading state
 * alike: the first render is the page as it stays, with nothing waiting to arrive.
 */
export function DashboardServerDataProvider({
  checklist,
  allSetHidden,
  children,
}: DashboardServerData & { children: ReactNode }) {
  return <ServerData value={{ checklist, allSetHidden }}>{children}</ServerData>
}

type SummaryKey = keyof typeof STATEMENT_ICONS

function summaryKeyOf(key: string): SummaryKey {
  // `setup.cap.<capability>.<on|off>`
  return key.split('.')[2] as SummaryKey
}

function roleKey(template: string | null) {
  return isRoleTemplateKey(template) ? (`roles.${template}` as const) : 'roles.custom'
}

function Welcome({ name, role }: { name: string; role: string }) {
  const { t } = useTranslation()
  return (
    <section
      aria-labelledby="business-title"
      className="relative isolate overflow-hidden rounded-2xl bg-linear-to-br from-brand to-primary px-5 py-6 text-white shadow-sm sm:px-8 sm:py-8 rtl:bg-linear-to-bl"
    >
      <LogoMark
        inverse
        className="absolute -end-4 -bottom-6 -z-10 size-36 opacity-15 sm:end-6 sm:size-44"
      />
      <p className="text-sm font-medium text-white/80">{t('home.welcome')}</p>
      {/* At the page's start side in both languages, the whole name on as many lines as it needs;
          the name keeps its own direction. */}
      <h1
        id="business-title"
        className="mt-1 text-2xl font-semibold tracking-tight text-balance break-words text-start sm:text-3xl"
      >
        <span dir="auto">{name}</span>
      </h1>
      <p className="mt-1.5 text-sm text-white/80">{role}</p>
    </section>
  )
}

/** What the setup says about the business (docs/PRODUCT.md §6.8), from the saved capabilities. */
function AboutBusiness({
  context,
  narrow,
  headingRef,
  className,
}: {
  context: BusinessContextDto
  /** Beside the checklist (from 1280px): one statement per row there. */
  narrow: boolean
  headingRef: Ref<HTMLHeadingElement>
  className?: string
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const summary = businessSummaryKeys(context.capabilities as Capabilities)
  return (
    <section
      aria-labelledby="about-title"
      className={cn(
        'rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06] sm:p-6',
        className,
      )}
    >
      <h2
        id="about-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold outline-none"
      >
        {t('setup.review.groups.about')}
      </h2>
      <ul
        className={cn(
          'mt-4 grid gap-3 sm:grid-cols-2',
          narrow ? 'xl:grid-cols-1' : 'xl:grid-cols-3',
        )}
      >
        {summary.map((key) => {
          const Icon = STATEMENT_ICONS[summaryKeyOf(key)]
          const on = key.endsWith('.on')
          return (
            <li
              key={key}
              data-statement={summaryKeyOf(key)}
              className="flex items-center gap-3 rounded-xl border bg-background/60 p-3"
            >
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  on ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon aria-hidden className="size-[1.125rem]" />
              </span>
              <span className="min-w-0 text-sm leading-snug font-medium">
                {term(key, context.terminologyProfile)}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-5 flex items-start gap-2.5 border-t pt-4 text-sm leading-relaxed text-muted-foreground">
        <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t('business.sectionsNote')}
      </p>
    </section>
  )
}

function DashboardView({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const server = useContext(ServerData)
  const trpc = useTRPC()
  const { data: me } = useMe()
  const { data: context } = useBusinessContext()
  const aboutTitle = useRef<HTMLHeadingElement>(null)
  const steps = context ? checklistItemIds(context.capabilities, (key) => can(context, key)) : []
  const checklist = useQuery({
    ...trpc.dashboard.checklist.queryOptions(),
    enabled: steps.length > 0,
    // From the server (used when this business's cache has none yet).
    initialData: server.checklist ?? undefined,
  })
  const [hidden, hide] = useAllSetHidden(me?.profile.id ?? '', businessId, server.allSetHidden)
  const membership = me?.memberships.find((m) => m.businessId === businessId)
  if (!membership || !context) return null

  const items = checklist.data?.items ?? []
  const complete = progressOf(items).complete
  let top: 'checklist' | 'loading' | 'error' | 'allSet' | null = null
  if (steps.length > 0) {
    // A member who hid "You're all set" sees no placeholder while the state loads.
    if (checklist.isPending) top = hidden ? null : 'loading'
    else if (checklist.isError) top = 'error'
    else if (items.length === 0) top = null
    else if (!complete) top = 'checklist'
    else top = hidden ? null : 'allSet'
  }
  const beside = top === 'checklist' || top === 'loading'

  return (
    <PageContainer>
      <div className="space-y-6">
        <Welcome name={membership.legalName} role={t(roleKey(membership.roleTemplateKey))} />
        {top === 'allSet' ? (
          <AllSet
            onHide={() => {
              hide()
              // The Hide button goes away with the card: the focus goes to what follows it.
              aboutTitle.current?.focus()
            }}
          />
        ) : null}
        {top === 'error' ? (
          <LoadError error={checklist.error} onRetry={() => void checklist.refetch()} />
        ) : null}
        {/* Side by side from 1280px: below that the page area beside the sidebar is too narrow. */}
        <div className={cn(beside && 'grid gap-6 xl:grid-cols-5 xl:items-start')}>
          {top === 'checklist' ? (
            <Checklist businessId={businessId} items={items} className="xl:col-span-3" />
          ) : null}
          {top === 'loading' ? (
            <ChecklistSkeleton steps={steps.length} className="xl:col-span-3" />
          ) : null}
          <AboutBusiness
            context={context}
            narrow={beside}
            headingRef={aboutTitle}
            className={cn(beside && 'xl:col-span-2')}
          />
        </div>
      </div>
    </PageContainer>
  )
}

/**
 * The business home (`/b/[businessId]`), the Dashboard module's page: open to members who may view
 * the dashboard (dashboard.home.view). Others go to their first section (the layout redirects on the
 * server; this covers a change of access while the page is open), or see "This page isn't open to
 * you" when they have none.
 */
export function Dashboard() {
  const { businessId } = useParams<{ businessId: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const { data: context } = useBusinessContext()
  const elsewhere =
    context && moduleAccess(context.modules, 'dashboard', 'dashboard') !== 'open'
      ? wayBack(shellNav(context.modules, businessId, pathname), 'dashboard')?.href
      : undefined
  useEffect(() => {
    if (elsewhere) router.replace(elsewhere)
  }, [elsewhere, router])
  if (elsewhere) return null
  return (
    <ModuleGate moduleId="dashboard" entryId="dashboard">
      <DashboardView businessId={businessId} />
    </ModuleGate>
  )
}
