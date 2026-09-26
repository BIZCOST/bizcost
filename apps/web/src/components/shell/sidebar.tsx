'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo, LogoMark } from '@/components/brand/logo'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocale } from '@/lib/i18n/client'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { BusinessSwitcher } from './business-switcher'
import type { NavSlots, ShellNavItem } from './nav'
import { navIcon } from './nav-icons'
import { SIDEBAR_WIDTH } from './sizes'

// The sidebar of a business (D-089), on the start side: from 1024px 16rem wide with the logo, the
// business switcher and the sections with their names; from 768px a rail of icons whose names show
// in a tooltip (and stay the links' accessible names). Hidden on phones, which have the tab bar.
// The tooltip only shows the name: it is hidden from screen readers and not the link's description,
// which would say the name twice.

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
  slots,
}: {
  items: readonly ShellNavItem[]
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
