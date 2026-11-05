import { SUPPORT_EMAIL } from '@bizcost/contracts'
import Link from 'next/link'
import { getT } from '@/lib/i18n/server'
import type { LegalDocument } from './content'

/**
 * A legal page (D-358), public and in the page's language. Rendered on the server from the `legal`
 * messages, which never go to the browser.
 */
export async function LegalPage({
  document,
  other,
}: {
  document: LegalDocument
  other: 'privacy' | 'terms'
}) {
  const t = await getT()
  const email = { email: SUPPORT_EMAIL }
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t(document.title)}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t('legal.version')}</p>
      </header>
      <p
        role="note"
        data-beta-notice
        className="mt-6 rounded-xl border border-info/25 bg-info/5 px-4 py-3 text-sm leading-relaxed"
      >
        {t('legal.betaNotice')}
      </p>
      <p className="mt-6 leading-relaxed">{t(document.intro)}</p>
      <p className="mt-3 leading-relaxed">{t('legal.operator', email)}</p>
      {document.sections.map((section) => (
        <section key={section.title} className="mt-8">
          <h2 className="text-lg font-semibold">{t(section.title)}</h2>
          {section.paragraphs?.map((key) => (
            <p key={key} className="mt-2 leading-relaxed">
              {t(key, email)}
            </p>
          ))}
          {section.lead ? <p className="mt-2 leading-relaxed">{t(section.lead)}</p> : null}
          {section.list ? (
            <ul className="mt-2 list-disc space-y-2 ps-5 leading-relaxed">
              {section.list.map((key) => (
                <li key={key}>{t(key, email)}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
      <footer className="mt-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t pt-6 text-sm">
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary hover:underline">
          {t('legal.contact', email)}
        </a>
        <Link href={`/${other}`} className="font-medium text-primary hover:underline">
          {t(`legal.links.${other}`)}
        </Link>
      </footer>
    </article>
  )
}
