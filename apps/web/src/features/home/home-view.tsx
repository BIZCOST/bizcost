'use client'

import { useMe } from '@bizcost/app-core'
import type { MembershipDto } from '@bizcost/contracts'
import { isRoleTemplateKey } from '@bizcost/modules'
import { ArrowRightIcon, Building2Icon, SparklesIcon, StoreIcon } from 'lucide-react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { Avatar, PersonName } from '@/components/app/avatar'
import { isolate } from '@/components/form/use-message'
import { useSessionEmail } from '@/lib/session'

function roleKey(template: string | null) {
  return isRoleTemplateKey(template) ? (`roles.${template}` as const) : 'roles.custom'
}

function BusinessList({ memberships }: { memberships: MembershipDto[] }) {
  const { t } = useTranslation()
  return (
    <ul className="divide-y">
      {memberships.map((membership) => (
        <li key={membership.businessId} className="flex items-center gap-4 px-5 py-4 sm:px-6">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
            <StoreIcon aria-hidden className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <PersonName className="font-medium">{membership.legalName}</PersonName>
            <p className="text-sm text-muted-foreground">
              {t(roleKey(membership.roleTemplateKey))}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

function EmptyBusinesses() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center sm:py-16">
      <span className="relative mb-5 flex size-16 items-center justify-center rounded-2xl bg-accent text-primary">
        <Building2Icon aria-hidden className="size-7" />
        <span className="absolute -end-1.5 -top-1.5 flex size-7 items-center justify-center rounded-full bg-card text-primary shadow-sm ring-1 ring-border">
          <SparklesIcon aria-hidden className="size-3.5" />
        </span>
      </span>
      <h3 className="text-lg font-semibold">{t('home.emptyTitle')}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {t('home.emptyBody')}
      </p>
    </div>
  )
}

export function HomeView() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const email = useSessionEmail()
  if (!me) return null
  const { profile, memberships } = me
  const active = memberships.filter((m) => m.status === 'active')
  // New profiles are named after the email's local part until the user sets a name: no greeting
  // by that name (docs/ARCHITECTURE.md §Auth).
  const named = profile.displayName !== '' && profile.displayName !== email?.split('@')[0]

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {named ? t('home.greeting', { name: isolate(profile.displayName) }) : t('home.welcome')}
        </h1>
        <p className="mt-1.5 text-muted-foreground">
          {named ? t('home.subtitle') : t('home.addName')}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <section
          aria-labelledby="businesses-title"
          className="min-w-0 overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06] lg:col-span-2"
        >
          <h2 id="businesses-title" className="border-b px-5 py-4 text-base font-semibold sm:px-6">
            {t('home.businessesTitle')}
          </h2>
          {active.length ? <BusinessList memberships={active} /> : <EmptyBusinesses />}
        </section>

        <section
          aria-labelledby="account-card-title"
          className="min-w-0 self-start rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06] sm:p-6"
        >
          <h2 id="account-card-title" className="sr-only">
            {t('nav.account')}
          </h2>
          <div className="flex items-center gap-3">
            <Avatar name={profile.displayName} className="size-12 text-base" />
            <div className="min-w-0">
              <PersonName className="font-medium">{profile.displayName}</PersonName>
              {email ? (
                <p dir="ltr" className="truncate text-sm text-muted-foreground rtl:text-end">
                  {email}
                </p>
              ) : null}
            </div>
          </div>
          <dl className="mt-5 space-y-2 border-t pt-4 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('language.label')}</dt>
              <dd lang={profile.locale}>{t(`language.${profile.locale}`)}</dd>
            </div>
          </dl>
          <Link
            href="/account"
            className="tap-area mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            {t('home.manageAccount')}
            <ArrowRightIcon aria-hidden className="size-4 rtl:rotate-180" />
          </Link>
        </section>
      </div>
    </div>
  )
}
