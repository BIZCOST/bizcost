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
    language: [],
  }
