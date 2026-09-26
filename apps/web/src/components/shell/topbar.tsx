'use client'

import { signOut, useMe } from '@bizcost/app-core'
import type { I18nKey } from '@bizcost/i18n'
import { HouseIcon, LogOutIcon, SettingsIcon, UserRoundIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Avatar, PersonName } from '@/components/app/avatar'
import { Logo, LogoMark } from '@/components/brand/logo'
import { isolate } from '@/components/form/use-message'
import { LanguageMenu } from '@/components/language-menu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePersistLanguage } from '@/features/account/use-persist-language'
import { activeMemberships, landingBusinessId } from '@/features/business/memberships'
import { useSessionEmail } from '@/lib/session'
import { authClient } from '@/lib/supabase/browser'
import { BusinessSwitcher } from './business-switcher'

// The top bar of the signed-in pages (D-089). Outside a business: the logo, the language and the
// account menu. In a business: the business switcher (phones and tablets; the sidebar holds it from
// 1024px), the language and the account menu, which are at the top end on every screen size.

/** The first thing a keyboard reaches: jumps over the header and the navigation to the page. */
export function SkipLink() {
  const { t } = useTranslation()
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow"
    >
      {t('nav.skipToContent')}
    </a>
  )
}

function UserMenu() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId?: string }>()
  const { data: me } = useMe()
  const email = useSessionEmail()
  const [signingOut, setSigningOut] = useState(false)
  const name = me?.profile.displayName ?? ''
  // In one of the user's businesses (not a business that is not open to them, or a mistyped one).
  const inBusiness =
    me && businessId ? activeMemberships(me).some((m) => m.businessId === businessId) : false
  // Outside a business (e.g. /account), Settings opens the business home would open.
  const settingsBusinessId = inBusiness ? businessId : me ? landingBusinessId(me) : null

  async function handleSignOut() {
    setSigningOut(true)
    // This device only; "Sign out everywhere" is on the account page (D-066).
    const result = await signOut(authClient(), 'local')
    if (!result.ok) {
      setSigningOut(false)
      toast.error(t(result.error as I18nKey))
      return
    }
    // A full page load drops every cached query of this user.
    window.location.assign('/login?notice=signed-out')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 gap-2 px-1.5 sm:pe-3 lg:pointer-fine:h-10"
          // The visible name is part of the button's name (WCAG 2.5.3).
          aria-label={name ? `${t('nav.accountMenu')}: ${isolate(name)}` : t('nav.accountMenu')}
          disabled={signingOut}
        >
          <Avatar name={name} className="size-8 text-sm" />
          <PersonName className="hidden max-w-40 text-sm font-medium sm:block">{name}</PersonName>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-3 py-2 font-normal">
          <Avatar name={name} className="size-9 text-sm" />
          <span className="min-w-0">
            <PersonName className="text-sm font-medium text-foreground">{name}</PersonName>
            {email ? (
              <span dir="ltr" className="block truncate text-xs text-muted-foreground rtl:text-end">
                {email}
              </span>
            ) : null}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* In a business the sections' Dashboard is home: no second link with the same purpose. */}
        {inBusiness ? null : (
          <DropdownMenuItem asChild className="py-2">
            <Link href="/">
              <HouseIcon aria-hidden />
              {t('nav.home')}
            </Link>
          </DropdownMenuItem>
        )}
        {settingsBusinessId ? (
          <DropdownMenuItem asChild className="py-2">
            <Link href={`/b/${settingsBusinessId}/settings`}>
              <SettingsIcon aria-hidden />
              {t('nav.settings')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild className="py-2">
          <Link href="/account">
            <UserRoundIcon aria-hidden />
            {t('nav.account')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="py-2"
          onSelect={(event) => {
            event.preventDefault()
            void handleSignOut()
          }}
        >
          <LogOutIcon aria-hidden className="rtl:rotate-180" />
          {t('actions.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The language and the account menu, at the top end of every page. */
function HeaderActions({ compactLanguage }: { compactLanguage: boolean }) {
  const persistLanguage = usePersistLanguage()
  return (
    <div className="flex shrink-0 items-center gap-1 sm:gap-2">
      <LanguageMenu
        persist={persistLanguage}
        compact={compactLanguage}
        className="min-w-11 px-2 sm:px-3"
      />
      <UserMenu />
    </div>
  )
}

const BAR =
  'sticky top-0 z-40 border-b bg-card/90 backdrop-blur supports-backdrop-filter:bg-card/80'

/** Pages outside a business (home, account, Smart Setup): the logo, language and account. */
export function PlainTopbar() {
  const { t } = useTranslation()
  return (
    <header className={BAR}>
      <SkipLink />
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
        <Link
          href="/"
          aria-label={t('brand.logoLabel')}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md"
        >
          <Logo />
        </Link>
        <HeaderActions compactLanguage={false} />
      </div>
    </header>
  )
}

/**
 * The top bar of a business page. Phones: the logo mark and the switcher; tablets: the switcher (the
 * rail has the logo); from 1024px the sidebar has both, and the bar keeps the language and account.
 */
export function BusinessTopbar() {
  const { t } = useTranslation()
  return (
    <header className={BAR}>
      <div className="flex h-16 items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            aria-label={t('brand.logoLabel')}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md md:hidden"
          >
            <LogoMark className="size-7" />
          </Link>
          <BusinessSwitcher className="lg:hidden" />
        </div>
        <HeaderActions compactLanguage />
      </div>
    </header>
  )
}
