import { APP_ERROR_CODES } from '@bizcost/contracts'
import { LOCALES, type Locale } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NAMESPACE, hasMessage, NAMESPACES, resources, type Messages } from './resources'

// Translation completeness: CI fails when either language lacks a key, a plural form or an
// interpolation variable, or when a message is empty.

const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/
const VARIABLE = /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g

function flatten(messages: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') out.set(`${prefix}${key}`, value)
    else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v)
  }
  return out
}

interface Entry {
  /** Plural categories present (empty for a plain message). */
  forms: Set<string>
  variables: Set<string>
  texts: string[]
}

/** Messages grouped by key without the plural suffix. */
function entries(locale: Locale): Map<string, Entry> {
  const out = new Map<string, Entry>()
  for (const ns of NAMESPACES) {
    for (const [key, text] of flatten(resources[locale][ns], `${ns}.`)) {
      const match = PLURAL.exec(key)
      const base = match ? match[1]! : key
      const entry = out.get(base) ?? { forms: new Set(), variables: new Set(), texts: [] }
      if (match) entry.forms.add(match[2]!)
      for (const [, name] of text.matchAll(VARIABLE)) entry.variables.add(name!)
      entry.texts.push(text)
      out.set(base, entry)
    }
  }
  return out
}

const byLocale = Object.fromEntries(LOCALES.map((l) => [l, entries(l)])) as Record<
  Locale,
  Map<string, Entry>
>
const sorted = (values: Iterable<string>) => [...values].sort()

describe('translations', () => {
  it('have the same keys in English and Arabic', () => {
    const en = sorted(byLocale.en.keys())
    const ar = sorted(byLocale.ar.keys())
    expect(
      ar.filter((k) => !en.includes(k)),
      'keys only in ar',
    ).toEqual([])
    expect(
      en.filter((k) => !ar.includes(k)),
      'keys missing in ar',
    ).toEqual([])
  })

  it.each(LOCALES)('%s: plural keys have exactly the forms of the language', (locale) => {
    const categories = sorted(new Intl.PluralRules(locale).resolvedOptions().pluralCategories)
    for (const [key, entry] of byLocale[locale]) {
      if (entry.forms.size > 0) expect(sorted(entry.forms), key).toEqual(categories)
    }
  })

  it('are plural in both languages or in neither', () => {
    for (const [key, entry] of byLocale.en) {
      expect(byLocale.ar.get(key)!.forms.size > 0, key).toBe(entry.forms.size > 0)
    }
  })

  it.each(LOCALES)('%s: has no empty messages', (locale) => {
    for (const [key, entry] of byLocale[locale]) {
      for (const text of entry.texts) expect(text.trim(), key).not.toBe('')
    }
  })

  it('use the same interpolation variables in both languages', () => {
    for (const [key, entry] of byLocale.en) {
      expect(sorted(byLocale.ar.get(key)!.variables), key).toEqual(sorted(entry.variables))
    }
  })

  it('show Latin digits in Arabic (Arabic-Indic digits are only accepted as input)', () => {
    for (const [key, entry] of byLocale.ar) {
      for (const text of entry.texts) expect(text, key).not.toMatch(/[٠-٩۰-۹]/)
    }
  })

  it('have an errors.<code> message for every API error code', () => {
    for (const locale of LOCALES) {
      for (const code of APP_ERROR_CODES)
        expect(hasMessage(locale, `errors.${code}`), code).toBe(true)
    }
  })

  it('have no common key that reads as another namespace (unprefixed keys are common keys)', () => {
    for (const locale of LOCALES) {
      const topLevel = Object.keys(resources[locale][DEFAULT_NAMESPACE])
      expect(topLevel.filter((k) => (NAMESPACES as readonly string[]).includes(k))).toEqual([])
    }
  })
})

describe('hasMessage', () => {
  it('finds plain and plural messages by their key', () => {
    expect(hasMessage('ar', 'auth.login.title')).toBe(true)
    expect(hasMessage('ar', 'auth.verify.resendIn')).toBe(true)
    expect(hasMessage('en', 'errors.internal')).toBe(true)
  })

  it('rejects unknown keys, namespaces, objects and suffixed plural forms', () => {
    expect(hasMessage('en', 'auth.login.nope')).toBe(false)
    expect(hasMessage('en', 'nope.title')).toBe(false)
    expect(hasMessage('en', 'auth.login')).toBe(false)
    expect(hasMessage('en', 'auth')).toBe(false)
    expect(hasMessage('en', 'auth.verify.resendIn_other.x')).toBe(false)
  })
})
