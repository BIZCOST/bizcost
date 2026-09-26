'use client'

import { EllipsisIcon, PlusIcon, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  bottomTabs,
  TAB_SLOTS,
  type NavSlots,
  type ShellNavItem,
  type ShellQuickAction,
} from './nav'
import { navIcon } from './nav-icons'

// The phone's tab bar (below 768px, D-089): the released sections the business has on and the member
// may use, fixed at the bottom above the home indicator (safe-area inset). Each tab is at least 44px
// tall. "More" holds what does not fit; "+" shows only when a module has "+" actions.

const TAB =
  'flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[0.6875rem] leading-none font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring'

function TabFace({
  icon: Icon,
  label,
  active,
}: {
  icon: LucideIcon
  label: string
  active: boolean
}) {
  return (
    <>
      <span
        className={cn(
          'flex h-7 w-12 items-center justify-center rounded-full transition-colors',
          active ? 'bg-accent text-primary' : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <span
        className={cn(
          'max-w-full truncate',
          active ? 'font-semibold text-primary' : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </>
  )
}

function Tab({ item }: { item: ShellNavItem }) {
  const { t } = useTranslation()
  return (
    <Link href={item.href} aria-current={item.active ? 'page' : undefined} className={TAB}>
      <TabFace icon={navIcon(item.icon)} label={t(item.labelKey)} active={item.active} />
    </Link>
  )
}

function MenuTab({
  label,
  trigger,
  children,
}: {
  label: string
  trigger: ReactNode
  children: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={TAB} aria-label={label}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" sideOffset={10} className="w-60">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A tab's place while the business loads. */
function TabPlaceholder() {
  return (
    <span aria-hidden className={cn(TAB, 'pointer-events-none')}>
      <Skeleton className="h-7 w-12 rounded-full" />
      <Skeleton className="h-2.5 w-10 rounded" />
    </span>
  )
}

export function BottomNav({
  items,
  quickActions,
  slots,
}: {
  items: readonly ShellNavItem[]
  quickActions: readonly ShellQuickAction[]
  /** While the business loads: placeholders in the tabs' places (items is then empty). */
  slots?: NavSlots
}) {
  const { t } = useTranslation()
  const { tabs, more, quickAdd } = bottomTabs(items, quickActions)
  const middle = Math.ceil(tabs.length / 2)
  const cells: ReactNode[] = slots
    ? Array.from({ length: Math.min(slots.main + slots.system, TAB_SLOTS) }, (_, index) => (
        <TabPlaceholder key={index} />
      ))
    : tabs.map((item) => <Tab key={item.id} item={item} />)
  if (quickAdd) {
    cells.splice(
      middle,
      0,
      <MenuTab
        key="quick-add"
        label={t('nav.quickAdd')}
        trigger={
          <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
            <PlusIcon aria-hidden className="size-6" />
          </span>
        }
      >
        {quickActions.map((action) => {
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
      </MenuTab>,
    )
  }
  if (more.length > 0) {
    cells.push(
      <MenuTab
        key="more"
        label={t('nav.more')}
        trigger={
          <TabFace
            icon={EllipsisIcon}
            label={t('nav.more')}
            active={more.some((item) => item.active)}
          />
        }
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('nav.moreTitle')}
        </DropdownMenuLabel>
        {more.map((item) => {
          const Icon = navIcon(item.icon)
          return (
            <DropdownMenuItem key={item.id} asChild className="py-2.5">
              <Link href={item.href} aria-current={item.active ? 'page' : undefined}>
                <Icon aria-hidden />
                {t(item.labelKey)}
              </Link>
            </DropdownMenuItem>
          )
        })}
      </MenuTab>,
    )
  }
  return (
    <nav
      aria-label={t('nav.main')}
      aria-busy={slots ? true : undefined}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-card/85 md:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch gap-1 px-2 py-1.5">
        {cells.map((cell, index) => (
          <li key={index} className="flex min-w-0 flex-1 justify-center">
            {cell}
          </li>
        ))}
      </ul>
    </nav>
  )
}
