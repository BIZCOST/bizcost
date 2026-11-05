'use client'

import { apiErrorKey, signOut, useTRPC } from '@bizcost/app-core'
import { LEGAL_VERSION } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import { FileCheckIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/brand/logo'
import { FormAlert } from '@/components/form/form-alert'
import { LanguageMenu } from '@/components/language-menu'
import { Button } from '@/components/ui/button'
import { usePersistLanguage } from '@/features/account/use-persist-language'
import { authClient } from '@/lib/supabase/browser'

const LINK = 'font-medium text-primary underline underline-offset-2'

/**
 * Before anything else, for someone who has not accepted the terms in force (D-358): an account made
 * through "send me a code" never saw the sign-up form's box, and a new version asks again. Accepted once.
 * Its language menu saves to the profile: the (app) layout would put a cookie's language back.
 */
export function TermsGate() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const router = useRouter()
  const accept = useMutation(trpc.account.acceptTerms.mutationOptions())
  const [error, setError] = useState<I18nKey | null>(null)
  const persistLanguage = usePersistLanguage()

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <div className="flex w-full max-w-md items-center justify-between gap-4">
        <Logo />
        <LanguageMenu persist={persistLanguage} />
      </div>
      <main
        id="main"
        className="w-full max-w-md rounded-2xl bg-card p-6 text-center shadow-sm ring-1 ring-foreground/[0.06] sm:p-8"
      >
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-accent text-primary">
          <FileCheckIcon aria-hidden className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">{t('terms.title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('terms.body')}</p>
        <p className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
          <a href="/terms" target="_blank" rel="noreferrer" className={LINK}>
            {t('nav.terms')}
          </a>
          <a href="/privacy" target="_blank" rel="noreferrer" className={LINK}>
            {t('nav.privacy')}
          </a>
        </p>
        {error ? (
          <FormAlert tone="error" className="mt-4 text-start">
            {t(error)}
          </FormAlert>
        ) : null}
        <div className="mt-6 flex flex-col gap-2">
          <Button
            size="lg"
            disabled={accept.isPending}
            onClick={() => {
              setError(null)
              accept.mutate(
                { termsVersion: LEGAL_VERSION },
                {
                  onSuccess: () => router.refresh(),
                  onError: (caught) => setError(apiErrorKey(caught) as I18nKey),
                },
              )
            }}
          >
            {accept.isPending ? t('terms.accepting') : t('terms.accept')}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              void signOut(authClient(), 'local').finally(() => {
                window.location.assign('/login?notice=signed-out')
              })
            }}
          >
            {t('terms.signOut')}
          </Button>
        </div>
      </main>
    </div>
  )
}
