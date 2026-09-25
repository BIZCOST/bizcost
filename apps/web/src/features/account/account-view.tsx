'use client'

import type { I18nKey } from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'
import { DeleteAccountSection, SessionsSection } from './danger-sections'
import { EmailSection } from './email-section'
import { LanguageSection } from './language-section'
import { PasswordSection } from './password-section'
import { ProfileSection } from './profile-section'

/** The sections, in page order, for the section list on wide screens. */
const SECTIONS: readonly { anchor: string; title: I18nKey }[] = [
  { anchor: 'profile', title: 'account.profile.title' },
  { anchor: 'language', title: 'account.language.title' },
  { anchor: 'email', title: 'account.email.title' },
  { anchor: 'password', title: 'account.password.title' },
  { anchor: 'sessions', title: 'account.sessions.title' },
  { anchor: 'delete', title: 'account.delete.title' },
]

export function AccountView() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('account.title')}</h1>
        <p className="mt-1.5 text-muted-foreground">{t('account.subtitle')}</p>
      </header>
      <div className="lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10">
        <nav aria-label={t('account.title')} className="hidden lg:block">
          <ul className="sticky top-24 space-y-0.5 text-sm">
            {SECTIONS.map(({ anchor, title }) => (
              <li key={anchor}>
                <a
                  href={`#${anchor}`}
                  className={
                    anchor === 'delete'
                      ? 'block rounded-lg px-3 py-2 text-destructive hover:bg-destructive/5'
                      : 'block rounded-lg px-3 py-2 text-muted-foreground hover:bg-card hover:text-foreground'
                  }
                >
                  {t(title)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-6">
          <ProfileSection />
          <LanguageSection />
          <EmailSection />
          <PasswordSection />
          <SessionsSection />
          <DeleteAccountSection />
        </div>
      </div>
    </div>
  )
}
