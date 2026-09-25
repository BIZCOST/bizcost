'use client'

import { signOut } from '@bizcost/app-core'
import { LOCALE_COOKIE, type Locale } from '@bizcost/i18n'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { saveLocaleCookie } from '@/lib/i18n/locale-cookie'
import { authClient } from '@/lib/supabase/browser'

/**
 * The profile's language wins over this browser's cookie (docs/ARCHITECTURE.md §i18n & RTL): when
 * they differ (e.g. changed on another device), save the profile's and render again once. If the
 * cookie cannot be written, nothing happens (no refresh loop).
 */
export function LocaleSync({ locale }: { locale: Locale }) {
  const router = useRouter()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    saveLocaleCookie(locale)
    if (document.cookie.split('; ').includes(`${LOCALE_COOKIE}=${locale}`)) router.refresh()
  }, [locale, router])
  return null
}

/** The API no longer accepts the session: forget it on this device and go to sign-in. */
export function SessionEnded() {
  useEffect(() => {
    void signOut(authClient(), 'local').finally(() => {
      window.location.replace('/login?notice=session-ended')
    })
  }, [])
  return null
}
