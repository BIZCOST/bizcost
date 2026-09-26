import { dir, pickMessages } from '@bizcost/i18n'
import { colors } from '@bizcost/tokens'
import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google'
import type { CSSProperties, ReactNode } from 'react'
import { Providers } from '@/components/providers'
import { ROOT_MESSAGES } from '@/lib/i18n/route-messages'
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

// viewport-fit=cover: the phone's bottom tab bar keeps clear of the home indicator with
// env(safe-area-inset-bottom), which is 0 without it.
export const viewport: Viewport = { themeColor: colors.light.primary, viewportFit: 'cover' }

/**
 * The Latin face without next/font's metric fallback (a local Arial): in the Latin-first stack of
 * English pages that fallback would come before the Arabic face and draw Arabic names in Arial. The
 * Arabic face covers Latin too, and its own fallback follows both faces.
 */
const LATIN_FACE_ONLY = {
  '--font-plex-sans': plexSans.style.fontFamily.split(',')[0]!.trim(),
} as CSSProperties

/**
 * `<html lang dir>` comes from the request's locale on the server, so there is no flash. The browser
 * gets the root messages of that language only; routes add theirs (D-092).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale()
  return (
    <html
      lang={locale}
      dir={dir(locale)}
      className={`${plexSans.variable} ${plexSansArabic.variable}`}
      style={LATIN_FACE_ONLY}
    >
      <body>
        <Providers locale={locale} messages={pickMessages(locale, ROOT_MESSAGES)}>
          {children}
        </Providers>
      </body>
    </html>
  )
}
