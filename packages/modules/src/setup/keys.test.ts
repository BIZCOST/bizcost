import { hasMessage, resources } from '@bizcost/i18n'
import { TERMINOLOGY_PROFILES } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { ALWAYS_ENABLED_MODULE_IDS, MODULE_IDS } from '../manifests'
import { WORKPLACE_OPTIONS } from './answers'
import { SETUP_QUESTIONS } from './questions'
import { ALWAYS_ON_REASON, locationNameKey, REASON_VARIANTS } from './recommend'
import { moduleDescriptionKey, moduleNameKey, STATEMENT_KEYS } from './review'

// Invariant 10 (docs/PRODUCT.md §6.10): every key the question set, recommend() and the review use
// exists in English and Arabic, and every terminology overlay has its base message.

const listed = MODULE_IDS.filter((id) => !ALWAYS_ENABLED_MODULE_IDS.includes(id))

const USED: string[] = [
  // Questions, options and hints.
  ...SETUP_QUESTIONS.flatMap((q) => [
    q.titleKey,
    q.shortKey,
    ...q.options.flatMap((o) => [o.labelKey, ...(o.hintKey ? [o.hintKey] : [])]),
  ]),
  ...SETUP_QUESTIONS.filter((q) => q.hint({}) !== null).map((q) => `setup.q.${q.id}.hint`),
  'setup.q.work_setup.hint_included',
  // Reasons, notes, the jobs row and statements.
  ALWAYS_ON_REASON,
  ...MODULE_IDS.flatMap((id) => REASON_VARIANTS[id].map((v) => `setup.reason.${id}.${v}`)),
  'setup.note.orders.outside_pos',
  'setup.note.invoices.pos_off',
  'setup.jobs.name',
  'setup.jobs.desc',
  'setup.jobs.reason.custom_jobs',
  'setup.jobs.reason.services',
  ...STATEMENT_KEYS.flatMap((k) => ['topic', 'on', 'off'].map((p) => `setup.cap.${k}.${p}`)),
  'setup.cap.jobs_and_tasks.on',
  // Locations, module names and descriptions.
  ...WORKPLACE_OPTIONS.flatMap((w) => [locationNameKey(w, false), locationNameKey(w, true)]),
  ...listed.map(moduleNameKey),
  ...listed.flatMap((id) => moduleDescriptionKey(id) ?? []),
  // Wizard, name step, review and ready screens.
  ...[
    'title',
    'wizard.progress',
    'wizard.next',
    'wizard.back',
    'wizard.exit',
    'wizard.chooseOne',
    'wizard.chooseAtLeastOne',
    'wizard.exclusive',
    'wizard.sideName',
    'wizard.sideReview',
    'name.title',
    'name.hint',
    'name.placeholder',
    'name.required',
    'name.tooLong',
    'review.title',
    'review.subtitle',
    'review.banner',
    'review.soon',
    'review.groups.chosen',
    'review.groups.basics',
    'review.groups.about',
    'review.groups.more',
    'review.show',
    'review.hide',
    'review.alsoOn',
    'review.alsoOff',
    'review.teamNote',
    'review.vatNotSure',
    'review.needsVat',
    'review.confirm',
    'review.confirming',
    'review.change',
    'ready.title',
    'ready.body',
    'ready.go',
  ].map((k) => `setup.${k}`),
]

function flatten(messages: object, prefix: string): string[] {
  return Object.entries(messages).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : flatten(v as object, `${prefix}${k}.`),
  )
}

describe('Smart Setup keys (invariant 10)', () => {
  it('exist in English and Arabic', () => {
    const missing = USED.filter((key) => !hasMessage('en', key) || !hasMessage('ar', key))
    expect(missing).toEqual([])
  })

  it('cover every module description and reason the review can show', () => {
    for (const id of listed) {
      const texts = REASON_VARIANTS[id].length + (moduleDescriptionKey(id) ? 1 : 0)
      expect(texts, id).toBeGreaterThan(0)
    }
  })

  it('give every overlay (<key>_<profile>) its base message', () => {
    const suffix = new RegExp(`_(${TERMINOLOGY_PROFILES.join('|')})$`)
    const keys = [
      ...flatten(resources.en.setup, 'setup.'),
      ...flatten(resources.en.modules, 'modules.'),
    ]
    const overlays = keys.filter((k) => suffix.test(k))
    expect(overlays.sort()).toEqual(
      [
        'modules.materials.name_factory',
        'modules.materials.name_food',
        'modules.products.name_projects',
        'setup.cap.jobs_and_tasks.on_maker',
        'setup.jobs.desc_maker',
        'setup.jobs.name_maker',
        'setup.jobs.reason.custom_jobs_maker',
        'setup.jobs.reason.services_maker',
        'setup.reason.cost_engine.jobs_maker',
      ].sort(),
    )
    for (const key of overlays) expect(keys, key).toContain(key.replace(suffix, ''))
  })

  it('isolate Latin codes (CNC, POS, TRN, LPO) inside Arabic text', () => {
    for (const key of flatten(resources.ar.setup, '')) {
      const path = key.split('.')
      let text: unknown = resources.ar.setup
      for (const part of path) text = (text as Record<string, unknown>)[part]
      for (const code of ['CNC', 'POS', 'TRN', 'LPO']) {
        if (typeof text === 'string' && text.includes(code)) {
          expect(text, key).toContain(`⁦${code}⁩`)
        }
      }
    }
  })
})
