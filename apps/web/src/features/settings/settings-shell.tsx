'use client'

import { apiErrorCode, useMe } from '@bizcost/app-core'
import { OWNER_TEMPLATE_KEY } from '@bizcost/domain'
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  LockKeyholeIcon,
  LogOutIcon,
  UserRoundIcon,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PersonName } from '@/components/app/avatar'
import { Button } from '@/components/ui/button'
import { NoLongerMember } from '@/features/business/no-longer-member'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { LeaveBusinessDialog } from './member-dialogs'
import { SECTION_ICONS } from './section-icons'
import {
  isSectionVisible,
  SECTION_DESCRIPTIONS,
  SECTION_TITLES,
  sectionOfPath,
  sectionPath,
  visibleSections,
  type SettingsSection,
} from './sections'

// Settings of one business (ROADMAP.md Step 6), with their own layout until the app shell (Step 7):
// the home lists the sections this member may open; a section page has the list beside it from 1024px,
// and a "Settings" link back to the list on smaller screens.

/** The business name as `me` lists it (the header's switcher shows the same). */
function useBusinessName(businessId: string): string {
  const { data: me } = useMe()
  return me?.memberships.find((m) => m.businessId === businessId)?.legalName ?? ''
}

function AccountLink({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <Link
      href="/account"
      className={cn(
        'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-card hover:text-foreground',
        className,
      )}
    >
      <UserRoundIcon aria-hidden className="size-4 shrink-0" />
      {t('settings.account.title')}
    </Link>
  )
}

function SideNav({
  businessId,
  sections,
  current,
}: {
  businessId: string
  sections: readonly SettingsSection[]
  current: SettingsSection
}) {
  const { t } = useTranslation()
  const name = useBusinessName(businessId)
  return (
    <nav aria-label={t('settings.title')} className="sticky top-24">
      <Link
        href={sectionPath(businessId)}
        className="mb-3 block rounded-lg px-3 py-1.5 hover:bg-card"
      >
        <span className="block text-lg font-semibold tracking-tight">{t('settings.title')}</span>
        <PersonName className="text-sm text-muted-foreground">{name}</PersonName>
      </Link>
      <ul className="space-y-0.5">
        {sections.map((section) => {
          const Icon = SECTION_ICONS[section]
          const active = section === current
          return (
            <li key={section}>
              <Link
                href={sectionPath(businessId, section)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-card font-medium text-foreground shadow-sm ring-1 ring-foreground/[0.06]'
                    : 'text-muted-foreground hover:bg-card hover:text-foreground',
                )}
              >
                <Icon
                  aria-hidden
                  className={cn('size-4 shrink-0', active ? 'text-primary' : undefined)}
                />
                {t(SECTION_TITLES[section])}
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="mt-3 border-t pt-3">
        <AccountLink />
      </div>
    </nav>
  )
}

export function SettingsShell({
  businessId,
  children,
}: {
  businessId: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const pathname = usePathname()
  const context = useBusinessContext()
  const section = sectionOfPath(pathname)
  if (context.error && apiErrorCode(context.error) === 'forbidden') return <NoLongerMember />
  if (!context.data) return null

  if (!section) {
    return <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10 lg:py-12">{children}</div>
  }
  return (
    <div className="mx-auto max-w-6xl px-4 pt-3 pb-10 sm:px-6 sm:pt-6 lg:py-12">
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 xl:gap-12">
        <aside className="hidden lg:block">
          <SideNav
            businessId={businessId}
            sections={visibleSections(context.data)}
            current={section}
          />
        </aside>
        <div className="min-w-0">
          <Link
            href={sectionPath(businessId)}
            className="-ms-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline lg:hidden"
          >
            <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
            {t('settings.title')}
          </Link>
          {children}
        </div>
      </div>
    </div>
  )
}

function SectionCard({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <li>
      <Link
        href={href}
        className="group flex h-full items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/50 sm:items-start sm:rounded-2xl sm:bg-card sm:p-5 sm:shadow-sm sm:ring-1 sm:ring-foreground/[0.06] sm:hover:ring-primary/30"
      >
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
          <Icon aria-hidden className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{title}</span>
          <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
        <ChevronRightIcon
          aria-hidden
          className="size-5 shrink-0 text-muted-foreground rtl:rotate-180 sm:hidden"
        />
      </Link>
    </li>
  )
}

/** Settings home: the sections this member may open, their own account, and leaving the business. */
export function SettingsHome({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const name = useBusinessName(businessId)
  const { data: context } = useBusinessContext()
  const [leaving, setLeaving] = useState(false)
  if (!context) return null
  const sections = visibleSections(context)
  const isOwner = context.roleTemplateKey === OWNER_TEMPLATE_KEY
  return (
    <>
      <Link
        href={`/b/${businessId}`}
        className="-ms-2 mb-3 inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 shrink-0 rtl:rotate-180" />
        <span dir="auto" className="truncate">
          {name}
        </span>
      </Link>
      <header className="mb-6 sm:mb-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('settings.title')}</h1>
        {sections.length > 0 ? (
          <p className="mt-1.5 text-muted-foreground">{t('settings.subtitle')}</p>
        ) : null}
      </header>
      {sections.length > 0 ? (
        <ul
          aria-label={t('settings.businessSections')}
          className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06] sm:grid sm:grid-cols-2 sm:gap-4 sm:divide-y-0 sm:overflow-visible sm:rounded-none sm:bg-transparent sm:shadow-none sm:ring-0 lg:grid-cols-3"
        >
          {sections.map((section) => (
            <SectionCard
              key={section}
              href={sectionPath(businessId, section)}
              icon={SECTION_ICONS[section]}
              title={t(SECTION_TITLES[section])}
              description={t(SECTION_DESCRIPTIONS[section])}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-2xl bg-card p-5 text-sm leading-relaxed text-muted-foreground shadow-sm ring-1 ring-foreground/[0.06]">
          {t('settings.noSections')}
        </p>
      )}
      <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">
        {t('settings.account.group')}
      </h2>
      <ul className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06] sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:rounded-none sm:bg-transparent sm:shadow-none sm:ring-0 lg:grid-cols-3">
        <SectionCard
          href="/account"
          icon={UserRoundIcon}
          title={t('settings.account.title')}
          description={t('settings.account.description')}
        />
        {isOwner ? null : (
          <li>
            <button
              type="button"
              onClick={() => setLeaving(true)}
              className="group flex h-full w-full items-center gap-4 border-t px-4 py-4 text-start transition-colors hover:bg-destructive/5 sm:items-start sm:rounded-2xl sm:border-t-0 sm:bg-card sm:p-5 sm:shadow-sm sm:ring-1 sm:ring-foreground/[0.06] sm:hover:ring-destructive/30"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <LogOutIcon aria-hidden className="size-5 rtl:rotate-180" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-destructive">
                  {t('settings.leave.title')}
                </span>
                <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                  {t('settings.leave.description')}
                </span>
              </span>
            </button>
          </li>
        )}
      </ul>
      {leaving ? (
        <LeaveBusinessDialog businessName={name} onClose={() => setLeaving(false)} />
      ) : null}
    </>
  )
}

/** A section this member may not open (no permission, or the business doesn't use it). */
function NoAccess({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-2xl bg-card px-6 py-12 text-center shadow-sm ring-1 ring-foreground/[0.06]">
      <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <LockKeyholeIcon aria-hidden className="size-5" />
      </span>
      <h1 className="mt-4 text-lg font-semibold">{t('settings.noAccess.title')}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {t('settings.noAccess.body')}
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link href={sectionPath(businessId)}>{t('settings.noAccess.back')}</Link>
      </Button>
    </div>
  )
}

/**
 * A section page: its title and description, then the content, when this member may open it (the
 * API refuses it anyway otherwise).
 */
export function SectionPage({
  businessId,
  section,
  actions,
  children,
}: {
  businessId: string
  section: SettingsSection
  /** Beside the title from 640px, under it on phones (e.g. "Invite someone"). */
  actions?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  if (!context) return null
  if (!isSectionVisible(context, section)) return <NoAccess businessId={businessId} />
  return (
    <div>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t(SECTION_TITLES[section])}</h1>
          <p className="mt-1.5 text-muted-foreground">{t(SECTION_DESCRIPTIONS[section])}</p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </header>
      <div className="space-y-6">{children}</div>
    </div>
  )
}
