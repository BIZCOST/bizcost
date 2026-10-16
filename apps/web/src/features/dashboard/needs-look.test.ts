import { TERMINOLOGY_PROFILES } from '@bizcost/domain'
import { createI18n, hasMessage, LOCALES } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import { businessWording } from '../../components/shell/nav'
import { LOOK_KINDS, lookWords } from './needs-look'

// "Needs a look" speaks each business's words (PRODUCT.md §13, D-146, D-156): a recipe is food wording
// (retail says "items used", everyone else "materials used"), and a business that sells services or
// works in projects is never told about "that product" (M3 Step 6 review).

const RECIPE = { en: /recipe/i, ar: /وصف/ } as const
const PRODUCT = { en: /\bproducts?\b/i, ar: /منتج/ } as const
const ITEMS = { en: /\bitems\b/i, ar: /أصناف/ } as const
const RECIPE_ROWS = ['productsWithoutRecipe', 'materialsInNoRecipe'] as const

describe('Needs a look in the business’s words', () => {
  for (const locale of LOCALES) {
    const i18n = createI18n({ locale })
    const has = (key: string) => hasMessage(locale, key)
    for (const profile of TERMINOLOGY_PROFILES) {
      for (const servicesOnly of [false, true]) {
        it(`${locale}: ${profile}${servicesOnly ? ', services only' : ''}`, () => {
          const wording = businessWording({ profile, servicesOnly }, has)
          for (const kind of LOOK_KINDS) {
            const words = lookWords(kind, wording)
            // Every overlay is written in both languages, so both say the same thing.
            for (const key of Object.values(words)) {
              for (const other of LOCALES) expect(hasMessage(other, key), key).toBe(true)
            }
          }
          for (const kind of RECIPE_ROWS) {
            const words = lookWords(kind, wording)
            const texts = Object.values(words).map((key) => i18n.t(key))
            const said = texts.join(' | ')
            if (profile === 'food') {
              expect(i18n.t(words.title), said).toMatch(RECIPE[locale])
            } else {
              expect(said).not.toMatch(RECIPE[locale])
            }
            if (profile === 'projects' || servicesOnly) {
              expect(said).not.toMatch(PRODUCT[locale])
            }
          }
          if (profile === 'retail' && !servicesOnly) {
            const words = lookWords('productsWithoutRecipe', wording)
            expect(i18n.t(words.action)).toMatch(ITEMS[locale])
          }
        })
      }
    }
  }

  it('names the page in the button as the nav does', () => {
    const has = (key: string) => hasMessage('en', key)
    const i18n = createI18n({ locale: 'en' })
    const button = (profile: (typeof TERMINOLOGY_PROFILES)[number], servicesOnly: boolean) =>
      i18n.t(
        lookWords('materialsInNoRecipe', businessWording({ profile, servicesOnly }, has)).action,
      )
    expect(button('general', false)).toBe('See your products')
    expect(button('projects', false)).toBe('See your services and work items')
    expect(button('general', true)).toBe('See your services')
  })
})
