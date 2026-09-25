import type { TFunction } from 'i18next'
import { SearchCheckIcon, TargetIcon, TrendingUpIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/brand/logo'
import { LanguageMenu } from '@/components/language-menu'

// Layout of the sign-in pages: a centered card on phones and tablets; from 1024px a brand panel on
// the start side and the card on the end side (never a stretched phone screen on desktop).

function BrandPanel({ t }: { t: TFunction }) {
  const points = [
    { icon: TargetIcon, text: t('brand.points.trueCost') },
    { icon: SearchCheckIcon, text: t('brand.points.moneyLost') },
    { icon: TrendingUpIcon, text: t('brand.points.realProfit') },
  ]
  return (
    <aside className="relative hidden overflow-hidden bg-linear-to-br from-brand via-brand to-primary text-brand-foreground lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
      <Logo inverse size="lg" />
      <div className="relative z-10 max-w-lg">
        <p className="text-4xl leading-tight font-semibold text-balance xl:text-5xl xl:leading-tight">
          {t('brand.headline')}
        </p>
        <ul className="mt-10 space-y-5">
          {points.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-4 text-lg text-white/90">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/12 ring-1 ring-white/15">
                <Icon aria-hidden className="size-5" />
              </span>
              {text}
            </li>
          ))}
        </ul>
      </div>
      <p dir="ltr" className="relative z-10 text-sm text-white/85 rtl:text-end">
        © {new Date().getFullYear()} BizCost
      </p>
      {/* Decoration: the logo's ascending bars (never mirrored), large and faint. */}
      <div aria-hidden className="pointer-events-none absolute end-12 bottom-0">
        <div dir="ltr" className="flex items-end gap-4 opacity-[0.08]">
          <span className="block h-28 w-14 rounded-t-2xl bg-white" />
          <span className="block h-44 w-14 rounded-t-2xl bg-white" />
          <span className="block h-60 w-14 rounded-t-2xl bg-white" />
        </div>
      </div>
    </aside>
  )
}

export function AuthShell({ t, children }: { t: TFunction; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow"
      >
        {t('nav.skipToContent')}
      </a>
      <BrandPanel t={t} />
      <div className="flex min-h-dvh flex-col">
        <header className="flex items-center justify-between gap-4 px-4 pt-4 sm:px-8 sm:pt-6">
          <Link href="/login" aria-label={t('brand.logoLabel')} className="rounded-md lg:invisible">
            <Logo />
          </Link>
          <LanguageMenu />
        </header>
        <main
          id="main"
          className="flex flex-1 justify-center px-4 pt-6 pb-10 sm:items-center sm:px-8 sm:pt-4"
        >
          <div className="w-full max-w-[27rem]">{children}</div>
        </main>
      </div>
    </div>
  )
}

/** The card of one sign-in page. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <>
      <section className="rounded-2xl bg-card p-6 shadow-[0_1px_2px_rgb(16_24_40/0.04),0_8px_24px_-12px_rgb(16_24_40/0.12)] ring-1 ring-foreground/[0.06] sm:p-8">
        <header className="mb-6 space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {description ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </header>
        {children}
      </section>
      {footer ? (
        <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>
      ) : null}
    </>
  )
}
