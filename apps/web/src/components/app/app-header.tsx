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
import { BusinessSwitcher } from '@/components/app/business-switcher'
import { Logo, LogoMark } from '@/components/brand/logo'
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
import { useSessionEmail } from '@/lib/session'
import { authClient } from '@/lib/supabase/browser'

function UserMenu() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId?: string }>()
  const { data: me } = useMe()
  const email = useSessionEmail()
  const [signingOut, setSigningOut] = useState(false)
  const name = me?.profile.displayName ?? ''

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
          aria-label={t('nav.accountMenu')}
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
        <DropdownMenuItem asChild className="py-2">
          <Link href="/">
            <HouseIcon aria-hidden />
            {t('nav.home')}
          </Link>
        </DropdownMenuItem>
        {businessId ? (
          <DropdownMenuItem asChild className="py-2">
            <Link href={`/b/${businessId}/settings`}>
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

export function AppHeader() {
  const { t } = useTranslation()
  const persistLanguage = usePersistLanguage()
  // In a business, the business switcher sits next to the logo; phones show the logo mark only.
  const inBusiness = Boolean(useParams<{ businessId?: string }>().businessId)
  return (
    <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur supports-backdrop-filter:bg-card/80">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow"
      >
        {t('nav.skipToContent')}
      </a>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link
            href="/"
            aria-label={t('brand.logoLabel')}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md"
          >
            {inBusiness ? (
              <>
                <LogoMark className="size-7 sm:hidden" />
                <Logo className="hidden sm:inline-flex" />
              </>
            ) : (
              <Logo />
            )}
          </Link>
          {inBusiness ? (
            <>
              <span aria-hidden className="hidden h-6 w-px bg-border sm:block" />
              <BusinessSwitcher />
            </>
          ) : null}
        </div>
        <nav aria-label={t('nav.main')} className="flex shrink-0 items-center gap-1 sm:gap-2">
          <LanguageMenu
            persist={persistLanguage}
            compact={inBusiness}
            className="min-w-11 px-2 sm:px-3"
          />
          <UserMenu />
        </nav>
      </div>
    </header>
  )
}
