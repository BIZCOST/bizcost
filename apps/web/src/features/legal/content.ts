import type { I18nKey } from '@bizcost/i18n'

// The two legal pages' order: each section's title and paragraphs, or its list. A test holds this to
// the messages: every message of `legal` shows, and nothing here is missing in either language.

export interface LegalSection {
  readonly title: I18nKey
  readonly paragraphs?: readonly I18nKey[]
  /** A paragraph before the list. */
  readonly lead?: I18nKey
  readonly list?: readonly I18nKey[]
}

export interface LegalDocument {
  readonly title: I18nKey
  readonly intro: I18nKey
  readonly sections: readonly LegalSection[]
}

export const PRIVACY: LegalDocument = {
  title: 'legal.privacy.title',
  intro: 'legal.privacy.intro',
  sections: [
    {
      title: 'legal.privacy.keep.title',
      list: [
        'legal.privacy.keep.invited',
        'legal.privacy.keep.account',
        'legal.privacy.keep.business',
        'legal.privacy.keep.records',
        'legal.privacy.keep.team',
        'legal.privacy.keep.history',
        'legal.privacy.keep.feedback',
        'legal.privacy.keep.technical',
      ],
    },
    { title: 'legal.privacy.cookies.title', paragraphs: ['legal.privacy.cookies.body'] },
    {
      title: 'legal.privacy.where.title',
      lead: 'legal.privacy.where.intro',
      list: [
        'legal.privacy.where.supabase',
        'legal.privacy.where.vercel',
        'legal.privacy.where.resend',
        'legal.privacy.where.sentry',
        'legal.privacy.where.cloudflare',
        'legal.privacy.where.anthropic',
        'legal.privacy.where.mailbox',
      ],
    },
    {
      title: 'legal.privacy.use.title',
      list: [
        'legal.privacy.use.run',
        'legal.privacy.use.contact',
        'legal.privacy.use.improve',
        'legal.privacy.use.never',
      ],
    },
    {
      title: 'legal.privacy.who.title',
      list: ['legal.privacy.who.business', 'legal.privacy.who.other', 'legal.privacy.who.us'],
    },
    {
      title: 'legal.privacy.keeping.title',
      list: [
        'legal.privacy.keeping.account',
        'legal.privacy.keeping.remains',
        'legal.privacy.keeping.business',
        'legal.privacy.keeping.feedback',
        'legal.privacy.keeping.backups',
      ],
    },
    { title: 'legal.privacy.rights.title', paragraphs: ['legal.privacy.rights.body'] },
    { title: 'legal.privacy.changes.title', paragraphs: ['legal.privacy.changes.body'] },
  ],
}

export const TERMS: LegalDocument = {
  title: 'legal.terms.title',
  intro: 'legal.terms.intro',
  sections: [
    {
      title: 'legal.terms.who.title',
      list: ['legal.terms.who.invited', 'legal.terms.who.account', 'legal.terms.who.business'],
    },
    {
      title: 'legal.terms.beta.title',
      list: ['legal.terms.beta.free', 'legal.terms.beta.changes', 'legal.terms.beta.stop'],
    },
    {
      title: 'legal.terms.numbers.title',
      list: [
        'legal.terms.numbers.estimates',
        'legal.terms.numbers.advice',
        'legal.terms.numbers.documents',
      ],
    },
    { title: 'legal.terms.yours.title', paragraphs: ['legal.terms.yours.body'] },
    { title: 'legal.terms.use.title', list: ['legal.terms.use.law', 'legal.terms.use.abuse'] },
    { title: 'legal.terms.liability.title', paragraphs: ['legal.terms.liability.body'] },
    { title: 'legal.terms.changes.title', paragraphs: ['legal.terms.changes.body'] },
    { title: 'legal.terms.contact.title', paragraphs: ['legal.terms.contact.body'] },
  ],
}
