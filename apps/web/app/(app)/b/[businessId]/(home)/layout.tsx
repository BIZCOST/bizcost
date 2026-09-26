import { checklistItemIds } from '@bizcost/modules'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { moduleAccess, shellNav, wayBack } from '@/components/shell/nav'
import { ALL_SET_HIDDEN_COOKIE, isAllSetHidden } from '@/features/dashboard/all-set-cookie'
import { DashboardServerDataProvider } from '@/features/dashboard/dashboard'
import { can } from '@/features/settings/sections'
import { Messages } from '@/lib/i18n/messages'
import { DASHBOARD_MESSAGES } from '@/lib/i18n/route-messages'
import { getBusinessContext, getDashboardChecklist, getMe } from '@/lib/trpc/server'

/**
 * The Dashboard's messages and server data, for the page and its loading state (D-090, D-091): the
 * checklist and whether "You're all set" was hidden are known before anything is sent, so the page
 * never shows a placeholder that moves (the page itself does not wait on anything). A member who may
 * not use the Dashboard goes to their first section instead.
 */
export default async function DashboardLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ businessId: string }>
}) {
  const { businessId } = await params
  const [context, me, cookieStore] = await Promise.all([
    getBusinessContext(businessId),
    getMe(),
    cookies(),
  ])
  let checklist = null
  let allSetHidden = false
  // A refused business or an ended session: the business layout shows what they get.
  if (typeof context === 'object' && me) {
    if (moduleAccess(context.modules, 'dashboard', 'dashboard') !== 'open') {
      const other = wayBack(shellNav(context.modules, businessId, ''), 'dashboard')
      if (other) redirect(other.href)
    } else if (checklistItemIds(context.capabilities, (key) => can(context, key)).length > 0) {
      checklist = await getDashboardChecklist(businessId)
    }
    allSetHidden = isAllSetHidden(cookieStore.get(ALL_SET_HIDDEN_COOKIE)?.value, me.profile.id)
  }
  return (
    <Messages specs={DASHBOARD_MESSAGES}>
      <DashboardServerDataProvider checklist={checklist} allSetHidden={allSetHidden}>
        {children}
      </DashboardServerDataProvider>
    </Messages>
  )
}
