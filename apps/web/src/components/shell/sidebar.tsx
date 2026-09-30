'use client'

import { PlusIcon } from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo, LogoMark } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocale } from '@/lib/i18n/client'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { BusinessSwitcher } from './business-switcher'
import type { NavSlots, ShellNavItem, ShellQuickAction } from './nav'
import { navIcon } from './nav-icons'
import { SIDEBAR_WIDTH } from './sizes'

// The sidebar of a business (D-089), on the start side: from 1024px 16rem wide with the logo, the
// business switcher and the sections with their names; from 768px a rail of icons whose names show
// in a tooltip (and stay the links' accessible names). Hidden on phones, which have the tab bar.
// The tooltip only shows the name: it is hidden from screen readers and not the link's description,
// which would say the name twice. Above the sections, "Add new" holds the "+" actions the member may
// use (a new product, purchase or expense, D-189): a button with its name from 1024px, a "+" on the
// rail; the phone has them in its tab bar. With only one action it goes there directly, named after
// it ("New expense"), instead of opening a menu of one (D-200).

const ITEM = 'min-h-11 rounded-xl max-lg:mx-auto max-lg:size-12'

function NavLink({ item, named }: { item: ShellNavItem; named: boolean }) {
  const { t } = useTranslation()
  const { dir } = useLocale()
  const Icon = navIcon(item.icon)
  const label = t(item.labelKey)
  const [open, setOpen] = useState(false)
  return (
    <li>
      {/* Only the rail needs the tooltip: from 1024px the name is shown. Always controlled. */}
      <Tooltip open={!named && open} onOpenChange={setOpen}>
        <TooltipTrigger asChild aria-describedby={undefined}>
          <Link
            href={item.href}
            aria-current={item.active ? 'page' : undefined}
            className={cn(
              ITEM,
              'group flex items-center gap-3 text-sm font-medium transition-colors',
              'max-lg:justify-center lg:px-3',
              item.active
                ? 'bg-accent text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="size-5 shrink-0" />
            <span className="truncate max-lg:sr-only">{label}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent aria-hidden side={dir === 'rtl' ? 'left' : 'right'}>
          {label}
        </TooltipContent>
      </Tooltip>
    </li>
  )
}

const QUICK_ADD = (named: boolean) =>
  cn(
    'shadow-sm',
    named ? 'h-11 w-full justify-start gap-2.5 px-3 lg:pointer-fine:h-11' : 'mx-auto size-12',
  )

/** On the rail, a control's name shows in a tooltip only (from 1024px it is written out). */
function RailTooltip({ label, children }: { label: string; children: ReactNode }) {
  const { dir } = useLocale()
  const [open, setOpen] = useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild aria-describedby={undefined}>
        {children}
      </TooltipTrigger>
      <TooltipContent aria-hidden side={dir === 'rtl' ? 'left' : 'right'}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** "Add new": the "+" actions, as on the phone's tab bar; the one action itself when it is alone. */
function QuickAdd({ actions, named }: { actions: readonly ShellQuickAction[]; named: boolean }) {
  const { t } = useTranslation()
  const { dir } = useLocale()
  const [only] = actions.length === 1 ? actions : []
  if (only) {
    const name = t(only.labelKey)
    const link = (
      <Button asChild className={QUICK_ADD(named)} data-quick-add>
        <Link href={only.href} aria-label={named ? undefined : name}>
          <PlusIcon aria-hidden className="size-5" />
          {named ? name : null}
        </Link>
      </Button>
    )
    return named ? link : <RailTooltip label={name}>{link}</RailTooltip>
  }
  const label = t('nav.quickAdd')
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button className={QUICK_ADD(named)} aria-label={named ? undefined : label} data-quick-add>
        <PlusIcon aria-hidden className="size-5" />
        {named ? label : null}
      </Button>
    </DropdownMenuTrigger>
  )
  return (
    <DropdownMenu>
      {named ? trigger : <RailTooltip label={label}>{trigger}</RailTooltip>}
      <DropdownMenuContent
        align="start"
        side={named ? 'bottom' : dir === 'rtl' ? 'left' : 'right'}
        className="w-64"
      >
        {actions.map((action) => {
          const Icon = navIcon(action.icon)
          return (
            <DropdownMenuItem key={action.id} asChild className="py-2.5">
              <Link href={action.href}>
                <Icon aria-hidden />
                {t(action.labelKey)}
              </Link>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A section's place while the business loads. */
function NavPlaceholder() {
  return (
    <li aria-hidden className={cn(ITEM, 'flex items-center gap-3 max-lg:justify-center lg:px-3')}>
      <Skeleton className="size-5 shrink-0 rounded-md" />
      <Skeleton className="hidden h-3.5 w-24 lg:block" />
    </li>
  )
}

function Placeholders({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => <NavPlaceholder key={index} />)
}

export function Sidebar({
  items,
  quickActions,
  slots,
}: {
  items: readonly ShellNavItem[]
  /** The "+" actions the member may use (none: no "Add new"). */
  quickActions: readonly ShellQuickAction[]
  /** While the business loads: placeholders in the sections' places (items is then empty). */
  slots?: NavSlots
}) {
  const { t } = useTranslation()
  const named = useMediaQuery('(min-width: 1024px)')
  const main = items.filter((item) => item.group === 'main')
  const system = items.filter((item) => item.group === 'system')
  const hasSystem = slots ? slots.system > 0 : system.length > 0
  return (
    // Not a landmark of its own: the navigation inside is the landmark.
    <div
      className={cn(
        'sticky top-0 hidden h-dvh shrink-0 flex-col border-e bg-card md:flex',
        SIDEBAR_WIDTH,
      )}
    >
      <div className="flex h-16 shrink-0 items-center border-b px-3 max-lg:justify-center lg:px-5">
        <Link
          href="/"
          aria-label={t('brand.logoLabel')}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-md lg:justify-start"
        >
          <LogoMark className="size-7 lg:hidden" />
          <Logo className="hidden lg:inline-flex" />
        </Link>
      </div>
      <div className="hidden px-3 pt-4 lg:block">
        <BusinessSwitcher wide />
      </div>
      <nav
        aria-label={t('nav.main')}
        aria-busy={slots ? true : undefined}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4"
      >
        {quickActions.length > 0 && !slots ? (
          <div className="mb-4">
            <QuickAdd actions={quickActions} named={named} />
          </div>
        ) : null}
        <ul className="space-y-1">
          {slots ? (
            <Placeholders count={slots.main} />
          ) : (
            main.map((item) => <NavLink key={item.id} item={item} named={named} />)
          )}
        </ul>
        {hasSystem ? (
          <ul className="mt-auto space-y-1 border-t pt-3">
            {slots ? (
              <Placeholders count={slots.system} />
            ) : (
              system.map((item) => <NavLink key={item.id} item={item} named={named} />)
            )}
          </ul>
        ) : null}
      </nav>
    </div>
  )
}
