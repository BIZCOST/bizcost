'use client'

import { LOCALES, type Locale } from '@bizcost/i18n'
import { CheckIcon, LanguagesIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLocale } from '@/lib/i18n/client'
import { saveLocaleCookie } from '@/lib/i18n/locale-cookie'
import { cn } from '@/lib/utils'

/**
 * Switches the page language: saves it (the cookie, and for a signed-in user also the profile and
 * the auth emails' language through `persist`), then renders the page again on the server.
 */
export function useSwitchLanguage(persist?: (locale: Locale) => Promise<boolean>) {
  const router = useRouter()
  const { locale: current } = useLocale()
  const [pending, setPending] = useState(false)
  async function switchTo(locale: Locale) {
    if (locale === current || pending) return
    setPending(true)
    try {
      if (persist && !(await persist(locale))) return
      saveLocaleCookie(locale)
      router.refresh()
    } finally {
      setPending(false)
    }
  }
  return { current, pending, switchTo }
}

export function LanguageMenu({
  persist,
  className,
}: {
  persist?: (locale: Locale) => Promise<boolean>
  className?: string
}) {
  const { t } = useTranslation()
  const { current, pending, switchTo } = useSwitchLanguage(persist)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('gap-2 text-muted-foreground hover:text-foreground', className)}
          aria-label={`${t('language.change')}: ${t(`language.${current}`)}`}
          disabled={pending}
        >
          <LanguagesIcon aria-hidden className="size-4" />
          <span lang={current}>{t(`language.${current}`)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('language.label')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LOCALES.map((locale) => (
          <DropdownMenuItem
            key={locale}
            lang={locale}
            onSelect={() => void switchTo(locale)}
            aria-current={locale === current || undefined}
            className="justify-between py-2"
          >
            {t(`language.${locale}`)}
            {locale === current ? <CheckIcon aria-hidden className="size-4 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
