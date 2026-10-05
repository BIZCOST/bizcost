import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createI18nInstance,
  hasKey,
  isNamespace,
  LOCALES,
  pickMessages,
  type MessageSpec,
} from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_MESSAGES,
  AUTH_MESSAGES,
  CATALOG_MESSAGES,
  DASHBOARD_MESSAGES,
  EXPENSES_MESSAGES,
  MEMBER_ACCESS_MESSAGES,
  PRODUCT_COSTS_MESSAGES,
  PURCHASES_MESSAGES,
  ROOT_MESSAGES,
  RUNNING_COSTS_MESSAGES,
  SALES_MESSAGES,
  SETTINGS_MESSAGES,
  SETTINGS_SECTION_MESSAGES,
  SETUP_MESSAGES,
  SUPPLIERS_MESSAGES,
} from './route-messages'

// The browser holds only the messages its route was given (D-092). This guard reads the code of each
// route for the keys it translates literally (`t('…')`, `i18nKey="…"`) and checks the route's messages
// have every one of them, in both languages. Keys built at run time are covered by the pages' e2e
// tests.

const SRC = join(import.meta.dirname, '..', '..')

function files(...paths: string[]): string[] {
  return paths.flatMap((path) => {
    const full = join(SRC, path)
    if (/\.(ts|tsx)$/.test(path)) return [full]
    return readdirSync(full)
      .filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes('.test.'))
      .map((name) => join(full, name))
  })
}

const LITERAL_KEY = /\bt\(\s*['"`]([a-z][A-Za-z]*\.[\w.]+)['"`]|i18nKey="([a-z][A-Za-z]*\.[\w.]+)"/g

/** The keys translated literally in `paths`, as full keys (`common.` for unprefixed ones). */
function literalKeys(paths: string[]): string[] {
  const keys = new Set<string>()
  for (const file of files(...paths)) {
    for (const match of readFileSync(file, 'utf8').matchAll(LITERAL_KEY)) {
      const key = (match[1] ?? match[2])!
      keys.add(isNamespace(key.split('.')[0]) ? key : `common.${key}`)
    }
  }
  return [...keys].sort()
}

function missing(paths: string[], specs: readonly MessageSpec[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const locale of LOCALES) {
    const i18n = createI18nInstance({
      locale,
      messages: { [locale]: pickMessages(locale, [...ROOT_MESSAGES, ...specs]) },
    })
    const lacking = literalKeys(paths).filter((key) => !hasKey(i18n, key))
    if (lacking.length > 0) out[locale] = lacking
  }
  return out
}

const FORMS = 'components/form'

describe("each route's messages have the keys its code translates", () => {
  it('reads keys from the code', () => {
    expect(literalKeys(['features/dashboard'])).toContain('dashboard.checklist.title')
    expect(literalKeys(['components/shell'])).toContain('common.nav.main')
  })

  it('every page: the shells, states and shared components', () => {
    expect(
      missing(
        ['components/shell', 'components/states', 'components/app', 'components/language-menu.tsx'],
        [],
      ),
    ).toEqual({})
  })

  it('sign-in pages and the invitation page', () => {
    expect(
      missing(['features/auth', 'features/invite', 'components/auth', FORMS], AUTH_MESSAGES),
    ).toEqual({})
  })

  it('the account page', () => {
    expect(missing(['features/account', FORMS], ACCOUNT_MESSAGES)).toEqual({})
  })

  it('Smart Setup', () => {
    expect(missing(['features/setup'], SETUP_MESSAGES)).toEqual({})
  })

  it('home (no business yet): the root messages only', () => {
    expect(missing(['features/home'], [])).toEqual({})
  })

  it('the Dashboard', () => {
    expect(missing(['features/dashboard'], DASHBOARD_MESSAGES)).toEqual({})
  })

  it('Materials and Products & Services', () => {
    expect(missing(['features/catalog', 'components/ui'], CATALOG_MESSAGES)).toEqual({})
  })

  it('Suppliers', () => {
    const purchasing = 'features/purchasing'
    expect(
      missing(
        [
          `${purchasing}/suppliers-page.tsx`,
          `${purchasing}/supplier-sheet.tsx`,
          `${purchasing}/supplier-draft.ts`,
          'features/catalog/catalog-list.tsx',
          'features/catalog/catalog-loading.tsx',
        ],
        SUPPLIERS_MESSAGES,
      ),
    ).toEqual({})
  })

  it('Purchases, supplier returns and credit notes', () => {
    // The document parts the purchase editor shares (features/documents, M3 Step 2) too.
    expect(
      missing(['features/purchasing', 'features/documents', 'components/ui'], PURCHASES_MESSAGES),
    ).toEqual({})
  })

  it('Expenses: the list, the editor, the view, the categories and the shared parts', () => {
    const purchasing = 'features/purchasing'
    expect(
      missing(
        [
          'features/expenses',
          'features/documents/amounts.tsx',
          'features/documents/confirm-dialog.tsx',
          'features/documents/line-editor.tsx',
          'features/documents/panel.tsx',
          'features/documents/search-box.tsx',
          'features/documents/totals.tsx',
          `${purchasing}/payments-panel.tsx`,
          `${purchasing}/payment-sheet.tsx`,
          `${purchasing}/payment-draft.ts`,
          `${purchasing}/purchase-lines.tsx`,
          `${purchasing}/receipts.tsx`,
          `${purchasing}/supplier-sheet.tsx`,
          `${purchasing}/supplier-draft.ts`,
          'features/catalog/catalog-list.tsx',
          'features/catalog/catalog-loading.tsx',
          'components/ui',
        ],
        EXPENSES_MESSAGES,
      ),
    ).toEqual({})
  })

  it('Running Costs: the list, its form and the categories', () => {
    const expenses = 'features/expenses'
    expect(
      missing(
        [
          `${expenses}/running-costs-page.tsx`,
          `${expenses}/running-cost-sheet.tsx`,
          `${expenses}/running-cost-draft.ts`,
          `${expenses}/categories-sheet.tsx`,
          `${expenses}/category-field.tsx`,
          `${expenses}/data.ts`,
          'features/documents/amounts.tsx',
          'features/documents/confirm-dialog.tsx',
          'features/documents/panel.tsx',
          'features/catalog/catalog-list.tsx',
          'features/catalog/catalog-loading.tsx',
        ],
        RUNNING_COSTS_MESSAGES,
      ),
    ).toEqual({})
  })

  it('Product costs: the list, the breakdown, and the product form and recipe they open', () => {
    expect(
      missing(
        [
          'features/costing',
          'features/catalog',
          'features/documents/amounts.tsx',
          'features/documents/panel.tsx',
          'components/ui',
        ],
        PRODUCT_COSTS_MESSAGES,
      ),
    ).toEqual({})
  })

  it("Sales: the list, Today's sales, One sale and the sale as recorded (M3 Step 2)", () => {
    expect(
      missing(
        ['features/sales', 'features/documents', 'features/catalog', 'components/ui'],
        SALES_MESSAGES,
      ),
    ).toEqual({})
  })

  it("a member's page: their permissions and the branches they work in", () => {
    expect(
      missing(
        [
          'features/settings/member-access.tsx',
          'features/settings/member-branches.tsx',
          'features/settings/permission-switches.tsx',
          'features/settings/role-picker.tsx',
        ],
        [...SETTINGS_MESSAGES, ...MEMBER_ACCESS_MESSAGES],
      ),
    ).toEqual({})
  })

  it('settings: the home and every section', () => {
    const settings = 'features/settings'
    const sections = {
      business: ['business-profile.tsx', 'logo-section.tsx', 'module-names.ts'],
      locations: ['locations-settings.tsx'],
      channels: ['channels-settings.tsx'],
      members: ['members-settings.tsx', 'invitations.tsx', 'member-dialogs.tsx', 'role-picker.tsx'],
      roles: ['roles-settings.tsx', 'role-picker.tsx'],
      modules: ['customize-settings.tsx', '../setup/review-parts.tsx'],
      books: ['books-settings.tsx'],
      approval: ['approval-settings.tsx'],
      costing: ['costing-settings.tsx', 'costing-draft.ts', '../costing/words.tsx'],
      language: ['language-settings.tsx'],
    } as const
    expect(
      missing(
        [`${settings}/settings-shell.tsx`, `${settings}/settings-loading.tsx`],
        SETTINGS_MESSAGES,
      ),
    ).toEqual({})
    for (const [section, paths] of Object.entries(sections)) {
      const specs = [
        ...SETTINGS_MESSAGES,
        ...SETTINGS_SECTION_MESSAGES[section as keyof typeof sections],
      ]
      expect(
        missing(
          paths.map((path) => `${settings}/${path}`),
          specs,
        ),
        section,
      ).toEqual({})
    }
  })

  it('never sends the emails to the browser', () => {
    const all = [
      ROOT_MESSAGES,
      AUTH_MESSAGES,
      ACCOUNT_MESSAGES,
      SETUP_MESSAGES,
      DASHBOARD_MESSAGES,
      CATALOG_MESSAGES,
      SUPPLIERS_MESSAGES,
      PURCHASES_MESSAGES,
      EXPENSES_MESSAGES,
      RUNNING_COSTS_MESSAGES,
      PRODUCT_COSTS_MESSAGES,
      SALES_MESSAGES,
      SETTINGS_MESSAGES,
      MEMBER_ACCESS_MESSAGES,
      ...Object.values(SETTINGS_SECTION_MESSAGES),
    ].flat()
    expect(
      all.some((spec) => (typeof spec === 'string' ? spec : spec.namespace) === 'emails'),
    ).toBe(false)
  })
})
