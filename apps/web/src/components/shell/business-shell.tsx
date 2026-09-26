'use client'

import { apiErrorCode } from '@bizcost/app-core'
import { usePathname } from 'next/navigation'
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBusinessContext } from '@/lib/trpc/client'
import { BottomNav } from './bottom-nav'
import {
  shellNav,
  shellQuickActions,
  type NavSlots,
  type ShellNavItem,
  type ShellQuickAction,
} from './nav'
import { NoLongerMember } from './no-longer-member'
import { PlainShell } from './plain-shell'
import { Sidebar } from './sidebar'
import { TAB_BAR_PADDING } from './sizes'
import { BusinessTopbar, SkipLink } from './topbar'

const noSubscription = () => () => {}

/**
 * After a navigation inside the shell, or into a business from elsewhere (another business, the
 * account…), the link that was used is often gone and the browser leaves the focus nowhere (Next does
 * not move it). The focus then goes to the page area, so the next Tab continues in the page. A focus
 * that is still somewhere (e.g. the sidebar link that stays) is left alone, and so is the first page
 * of a visit (the shell came with the page's HTML: the skip link stays the first stop).
 */
function useFocusAfterNavigation(pathname: string): RefObject<HTMLElement | null> {
  const main = useRef<HTMLElement>(null)
  // True only while hydrating: the server snapshot is used then.
  const hydrating = useSyncExternalStore(
    noSubscription,
    () => false,
    () => true,
  )
  const [fromServer] = useState(hydrating)
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (seen.current === pathname) return
    const first = seen.current === null
    seen.current = pathname
    if (first && fromServer) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    main.current?.focus({ preventScroll: true })
  }, [pathname, fromServer])
  return main
}

/** The frame of the shell: the sidebar or rail, the top bar, the page area and the tab bar. */
function ShellFrame({
  items,
  quickActions,
  slots,
  mainRef,
  children,
}: {
  items: readonly ShellNavItem[]
  quickActions: readonly ShellQuickAction[]
  slots?: NavSlots
  mainRef?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <SkipLink />
      <div className="flex min-h-dvh">
        <Sidebar items={items} slots={slots} />
        <div className="flex min-w-0 flex-1 flex-col">
          <BusinessTopbar />
          <main
            ref={mainRef}
            id="main"
            tabIndex={-1}
            className={`flex-1 outline-none ${TAB_BAR_PADDING}`}
          >
            {children}
          </main>
        </div>
      </div>
      <BottomNav items={items} quickActions={quickActions} slots={slots} />
    </TooltipProvider>
  )
}

/**
 * The shell while a business opens or another one is chosen (`b/loading.tsx`): the real logo,
 * switcher (the business being opened, from `me`), language and account, placeholders where the
 * sections go, and the page's placeholder, so only the business's own parts change when it arrives.
 * Inert: the real shell replaces it in a moment, and a focus inside it would be lost then.
 */
export function LoadingShell({ slots, children }: { slots: NavSlots; children: ReactNode }) {
  return (
    <div inert className="contents">
      <ShellFrame items={[]} quickActions={[]} slots={slots}>
        {children}
      </ShellFrame>
    </div>
  )
}

/**
 * The app shell of a business (ROADMAP.md Step 7, D-089): the sidebar (from 1024px), the rail (768px)
 * or the tab bar (phones), and the top bar, around the business's pages. The sections come from
 * business.context only (nav.ts). When a refetch finds the member no longer in the business, the
 * shell gives way to "This business isn't open to you".
 */
export function BusinessShell({
  businessId,
  children,
}: {
  businessId: string
  children: ReactNode
}) {
  const pathname = usePathname()
  const context = useBusinessContext()
  const main = useFocusAfterNavigation(pathname)
  if (context.error && apiErrorCode(context.error) === 'forbidden') {
    return (
      <PlainShell>
        <NoLongerMember />
      </PlainShell>
    )
  }
  // Seeded by the layout, so always there.
  if (!context.data) return null
  return (
    <ShellFrame
      items={shellNav(context.data.modules, businessId, pathname)}
      quickActions={shellQuickActions(context.data.modules, businessId)}
      mainRef={main}
    >
      {children}
    </ShellFrame>
  )
}
