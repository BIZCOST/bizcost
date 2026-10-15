import { describe, expect, it } from 'vitest'
import ar from '../locales/ar/sales.json'
import arSettings from '../locales/ar/settings.json'
import { createI18n } from './create'

// The words of importing sales and of a channel's statements (M3 Step 4 review, D-261): simple MSA,
// the app's own terms ("Discard" a draft is «احذف», One sale is «عملية بيع», what an app takes is
// «ما يأخذه/أخذه التطبيق»), no rare passives, and a warning that says what can go wrong.

/** Every message under `node`, flattened. */
function messagesOf(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (node && typeof node === 'object') return Object.values(node).flatMap(messagesOf)
  return []
}

describe('the Arabic of importing sales and of statements', () => {
  const texts = [...messagesOf(ar.import), ...messagesOf(arSettings.channels.statements)]

  it('says «احذف» for Discard, as every other draft does', () => {
    const i18n = createI18n({ locale: 'ar' })
    expect(i18n.t('sales.import.discard')).toBe(i18n.t('sales.confirm.discardAction'))
    expect(i18n.t('settings.channels.statements.discard')).toBe('احذف')
    expect(texts.filter((text) => /تجاهل|تُجوهل/u.test(text))).toEqual([])
  })

  it('uses no rare passive or calque, and «عملية بيع» for a sale', () => {
    expect(texts.filter((text) => /تُجووز|احتفظ|مبيعة/u.test(text))).toEqual([])
  })

  it('says what goes wrong when a day also has Today’s sales, in both languages', () => {
    for (const locale of ['ar', 'en'] as const) {
      const i18n = createI18n({ locale })
      expect(i18n.t('sales.import.days.otherSales')).toMatch(locale === 'ar' ? /مرتين/u : /twice/)
      expect(i18n.t('sales.import.confirm.otherSalesNote')).toMatch(
        locale === 'ar' ? /مرتين/u : /twice/,
      )
    }
  })

  it('writes the English statement template hint as one row per statement', () => {
    const i18n = createI18n({ locale: 'en' })
    expect(i18n.t('settings.channels.statements.templateIntro')).toContain('one row per statement')
  })
})
