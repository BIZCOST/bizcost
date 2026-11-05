import { BETA_REFUSED_MESSAGE, SUPPORT_EMAIL } from '@bizcost/contracts'
import { hasMessage, pickMessages, type Messages } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import { PRIVACY, TERMS, type LegalDocument, type LegalSection } from './content'

// The legal pages say what they must (D-358): nothing written and left off the page, nothing on the page
// without its words in both languages, and the facts of where data goes in each language.

const keysOf = (document: LegalDocument) => [
  document.title,
  document.intro,
  ...document.sections.flatMap((section: LegalSection) => [
    section.title,
    ...(section.paragraphs ?? []),
    ...(section.lead ? [section.lead] : []),
    ...(section.list ?? []),
  ]),
]

/** One language's messages of `legal` and of the sign-in errors, as nested text. */
function legalOf(locale: 'en' | 'ar') {
  const bundle = pickMessages(locale, ['legal', { namespace: 'auth', paths: ['errors'] }])
  return { legal: bundle.legal as Messages, errors: (bundle.auth as Messages).errors as Messages }
}

function textAt(messages: Messages, path: string): string {
  const value = path.split('.').reduce<unknown>((at, key) => (at as Messages)[key], messages)
  return String(value)
}

function flatten(messages: object, prefix: string): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : flatten(value as object, `${prefix}${key}.`),
  )
}

describe('the legal pages', () => {
  it('show every message written for them, in both languages', () => {
    const shown = new Set([...keysOf(PRIVACY), ...keysOf(TERMS)])
    for (const locale of ['en', 'ar'] as const) {
      for (const key of shown) expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
      const written = flatten(legalOf(locale).legal, 'legal.').filter(
        (key) => key.startsWith('legal.privacy.') || key.startsWith('legal.terms.'),
      )
      expect(written.filter((key) => !shown.has(key as never))).toEqual([])
    }
  })

  it('name who handles the data, and where, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const { legal } = legalOf(locale)
      const where = (key: string) => textAt(legal, `privacy.where.${key}`)
      expect(where('supabase')).toContain('Supabase')
      expect(where('vercel')).toContain('Vercel')
      expect(where('resend')).toContain('Resend')
      expect(where('sentry')).toContain('Sentry')
      expect(where('cloudflare')).toContain('Turnstile')
      // Claude reads the feedback with the owner each week (beta-launch.md Step 5).
      expect(where('anthropic')).toContain('Claude')
      // A picture attached to feedback can show a page of records: no absolute promise over it.
      expect(where('anthropic')).toMatch(/picture|صورة/)
      expect(where('anthropic')).not.toMatch(/never|أبدًا/)
      // Mumbai, where the database and the app are.
      expect(where('supabase')).toMatch(/Mumbai|مومباي/)
      expect(where('vercel')).toMatch(/Mumbai|مومباي/)
      // Nothing else is in India: each of the others says its own place.
      expect(where('resend')).toMatch(/United States|الولايات المتحدة/)
      expect(where('sentry')).toMatch(/United States|الولايات المتحدة/)
      expect(where('anthropic')).toMatch(/United States|الولايات المتحدة/)
      expect(where('cloudflare')).toMatch(/country|بلد/)
      expect(where('mailbox')).toMatch(/country|بلد/)
    }
  })

  it('say who runs it, on both pages, and what they keep that is easy to forget', () => {
    for (const locale of ['en', 'ar'] as const) {
      const { legal } = legalOf(locale)
      expect(textAt(legal, 'operator')).toContain('{{email}}')
      expect(textAt(legal, 'operator')).toMatch(/founder|المؤسِّس/)
      expect(textAt(legal, 'privacy.keep.business')).toMatch(/bank|البنكية/)
      // The cookies: sign-in, language and the hidden cards, not "one and one".
      expect(textAt(legal, 'privacy.cookies.body')).toMatch(/cards|البطاقات/)
      // Deleting an account does not take the name from the history of changes (the audit log).
      expect(textAt(legal, 'privacy.keeping.remains')).toMatch(/history|سجل التغييرات/)
    }
  })

  it('say they are for the beta, on both pages, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      expect(textAt(legalOf(locale).legal, 'betaNotice')).toMatch(/beta|تجريبية/)
    }
  })

  it('and the refusal tells a person where to ask, without the hook’s code', () => {
    for (const locale of ['en', 'ar'] as const) {
      const refusal = textAt(legalOf(locale).errors, 'betaInviteOnly')
      expect(refusal).toContain(SUPPORT_EMAIL)
      expect(refusal).not.toContain(BETA_REFUSED_MESSAGE)
    }
  })
})
