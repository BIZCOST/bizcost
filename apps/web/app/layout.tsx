import { dir } from '@bizcost/i18n'
import { colors } from '@bizcost/tokens'
import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import { getLocale, getT } from '@/lib/i18n/server'
import './globals.css'

// Fonts: IBM Plex Sans Arabic + IBM Plex Sans (docs/ARCHITECTURE.md §Stack). The variable names are
// the ones packages/tokens expects; Arabic pages put the Arabic face first.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
})
const plexSansArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans-arabic',
  display: 'swap',
})

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: { default: t('appName'), template: `%s · ${t('appName')}` },
    description: t('tagline'),
  }
}

export const viewport: Viewport = { themeColor: colors.light.primary }

/** `<html lang dir>` comes from the request's locale on the server, so there is no flash. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale()
  return (
    <html
      lang={locale}
      dir={dir(locale)}
      className={`${plexSans.variable} ${plexSansArabic.variable}`}
    >
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  )
}
