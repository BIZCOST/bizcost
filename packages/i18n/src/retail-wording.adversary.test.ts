import { LOCALES, TERMINOLOGY_PROFILES, type Locale } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { NAMESPACES, resources, type Messages } from './resources'

// Review of M2 Step 4 (D-117): the retail profile calls materials "Goods / البضاعة". Every message the
// factory profile rewords ("Raw materials") names materials, so a retail business needs its own
// overlay of it too. Without one it reads "Goods" in the nav and on Customize BizCost, but "Add
// material", "No materials yet" and "Material" on the Goods page and in the purchase editor (D-128:
// one name for a section wherever it appears; PRODUCT.md §13).
//
// Second review: messages no other profile rewords named materials too ("Materials used" on the
// Products list and in the recipe, "…updates material costs" in Roles). So every message a shop
// reads in the screens that say "Goods" (the catalog, purchases, errors, the nav and the Roles
// editor), in the retail wording, names no materials.

function entriesOf(messages: Messages, prefix: string): [string, string][] {
  return Object.entries(messages).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : entriesOf(value, `${prefix}${key}.`),
  )
}

function messagesOf(locale: Locale): Map<string, string> {
  return new Map(NAMESPACES.flatMap((ns) => entriesOf(resources[locale][ns], `${ns}.`)))
}

/** The screens that say "Goods" in the retail wording (Smart Setup runs before a business has one). */
const RETAIL_SCREENS = [
  'catalog.',
  'purchasing.',
  'errors.',
  'modules.',
  'common.',
  'settings.permissionLabels.',
  'settings.permissionHints.',
]

const MATERIALS: Record<Locale, RegExp> = { en: /material/i, ar: /المواد|مادة|مواد/ }

const OVERLAY = new RegExp(`_(${TERMINOLOGY_PROFILES.join('|')})(_(zero|one|two|few|many|other))?$`)
const PLURAL = /_(zero|one|two|few|many|other)$/

describe('the retail wording (D-117)', () => {
  it.each(LOCALES)('rewords every message the factory profile rewords (%s)', (locale) => {
    const keys = new Set(messagesOf(locale).keys())
    const missing = [...keys]
      .filter((key) => key.endsWith('_factory'))
      .map((key) => key.replace(/_factory$/, '_retail'))
      .filter((key) => !keys.has(key))
    expect(missing).toEqual([])
  })

  it.each(LOCALES)('names no materials on the screens that say Goods (%s)', (locale) => {
    const messages = messagesOf(locale)
    const named = [...messages.keys()]
      .filter((key) => RETAIL_SCREENS.some((screen) => key.startsWith(screen)))
      .filter((key) => !OVERLAY.test(key))
      .map((key) => {
        // The retail overlay of `key` (`<key>_retail`, before a plural ending), else `key` itself.
        const plural = PLURAL.exec(key)?.[0] ?? ''
        const overlay = `${key.slice(0, key.length - plural.length)}_retail${plural}`
        return messages.has(overlay) ? overlay : key
      })
      .filter((key) => MATERIALS[locale].test(messages.get(key) ?? ''))
    expect(named).toEqual([])
  })
})
