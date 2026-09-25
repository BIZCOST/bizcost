'use client'

import { LOCALES } from '@bizcost/i18n'
import { CheckIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSwitchLanguage } from '@/components/language-menu'
import { Section } from './section'
import { usePersistLanguage } from './use-persist-language'

export function LanguageSection() {
  const { t } = useTranslation()
  const { current, pending, switchTo } = useSwitchLanguage(usePersistLanguage())
  return (
    <Section
      anchor="language"
      title={t('account.language.title')}
      description={t('account.language.description')}
    >
      <fieldset disabled={pending}>
        <legend className="sr-only">{t('language.label')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {LOCALES.map((locale) => (
            <label
              key={locale}
              lang={locale}
              className="flex h-14 cursor-pointer items-center justify-between gap-3 rounded-xl border bg-card px-4 text-[0.9375rem] font-medium transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring has-disabled:cursor-wait has-disabled:opacity-70"
            >
              <input
                type="radio"
                name="language"
                value={locale}
                checked={current === locale}
                onChange={() => void switchTo(locale)}
                className="sr-only"
              />
              {t(`language.${locale}`)}
              {current === locale ? (
                <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <CheckIcon aria-hidden className="size-3.5" />
                </span>
              ) : (
                <span aria-hidden className="size-6 rounded-full border-2 border-input" />
              )}
            </label>
          ))}
        </div>
      </fieldset>
    </Section>
  )
}
