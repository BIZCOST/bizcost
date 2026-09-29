import type { MessageSpec } from '@bizcost/i18n'
import type { SettingsSection } from '@/features/settings/sections'

// What each part of the app needs of the translations (D-092): the browser receives only these, in
// the page's language. Every page has ROOT; a route adds the specs of the layouts and pages it is in.
// `emails` is never sent: only the API writes emails.

/** Every page (root layout): the shared words and the error messages. */
export const ROOT_MESSAGES: readonly MessageSpec[] = ['common', 'errors']

/** Sign in, sign up, codes, password reset and the invitation page ((auth) layout). */
export const AUTH_MESSAGES: readonly MessageSpec[] = ['auth']

/** The account page: its sections and the code flows of sign-in. */
export const ACCOUNT_MESSAGES: readonly MessageSpec[] = ['account', 'auth']

/** Smart Setup: the questions, the review and the module names. */
export const SETUP_MESSAGES: readonly MessageSpec[] = ['setup', 'modules']

/** The Dashboard: its checklist, and the setup's statements about the business. */
export const DASHBOARD_MESSAGES: readonly MessageSpec[] = [
  'dashboard',
  { namespace: 'setup', paths: ['cap', 'review.groups.about'] },
]

/**
 * Materials and Products & Services (M2 Step 2; their layouts): the lists, the forms and the unit
 * names.
 */
export const CATALOG_MESSAGES: readonly MessageSpec[] = ['catalog', 'units']

/**
 * Suppliers (M2 Step 3; its layout): the list frame and form words of the catalog, and the
 * purchasing messages.
 */
export const SUPPLIERS_MESSAGES: readonly MessageSpec[] = [
  { namespace: 'catalog', paths: ['list', 'form', 'numbers'] },
  'purchasing',
]

/**
 * Purchases, supplier returns and credit notes (M2 Step 3; its layout): the purchasing messages,
 * the catalog's list and form words (the supplier and material forms open from a purchase) and the
 * unit names.
 */
export const PURCHASES_MESSAGES: readonly MessageSpec[] = ['catalog', 'units', 'purchasing']

/** The starter names of the categories (their order in the pickers, D-167). */
const STARTER_CATEGORIES: MessageSpec = { namespace: 'setup', paths: ['cost_categories'] }

/**
 * Expenses (M2 Step 5; its layout): the expenses messages, the purchasing messages (how it was paid,
 * the document types, receipts, payments and the supplier form), the catalog's list and form words and
 * the starter categories.
 */
export const EXPENSES_MESSAGES: readonly MessageSpec[] = [
  { namespace: 'catalog', paths: ['list', 'form', 'numbers'] },
  'purchasing',
  'expenses',
  STARTER_CATEGORIES,
]

/**
 * Running Costs (M2 Step 5; its layout): the expenses messages (running costs and the shared
 * categories), the catalog's list and form words, the few purchasing words of its form (and of the
 * money box), and the starter categories.
 */
export const RUNNING_COSTS_MESSAGES: readonly MessageSpec[] = [
  { namespace: 'catalog', paths: ['list', 'form', 'numbers'] },
  {
    namespace: 'purchasing',
    paths: [
      'optional',
      'notes',
      'notesHint',
      'tooLong',
      'editor.errors.date',
      'editor.amountPlaceholder',
    ],
  },
  'expenses',
  STARTER_CATEGORIES,
]

/** Settings of a business (layout): the section list, the settings home and every section's frame. */
export const SETTINGS_MESSAGES: readonly MessageSpec[] = ['settings']

/** What each settings section adds (its page). */
export const SETTINGS_SECTION_MESSAGES: Readonly<Record<SettingsSection, readonly MessageSpec[]>> =
  {
    // The sections switching VAT turns on or off, by name.
    business: ['modules', { namespace: 'setup', paths: ['review.alsoOn', 'review.alsoOff'] }],
    locations: [],
    // The note on a solo business, the invite form's email and "confirm it's you" (ownership).
    members: [
      { namespace: 'setup', paths: ['review.teamNote'] },
      { namespace: 'auth', paths: ['verify', 'fields', 'errors', 'validation'] },
    ],
    // A released module's permissions are grouped under its name.
    roles: ['modules'],
    // Customize BizCost: the setup's rules, statements and module names.
    modules: ['setup', 'modules'],
    // Closing the books: its own words (settings) only.
    books: [],
    // Whether expenses need approval: its own words (settings) only.
    approval: [],
    language: [],
  }
