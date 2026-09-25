import { hasMessage } from '@bizcost/i18n'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_KEYS, STORED_CAPABILITY_KEYS } from '../capabilities'
import { ALWAYS_ENABLED_MODULE_IDS, MODULE_IDS, MODULES, type ModuleId } from '../manifests'
import { has, sellsOrMakes, SETUP_QUESTION_IDS, type SetupAnswers } from './answers'
import {
  adjustmentsFor,
  applyAdjustments,
  isSetupItemOn,
  isValidSetupState,
  NO_ADJUSTMENTS,
  recommendedState,
  toggleSetupItem,
  type SetupAdjustments,
  type SetupItem,
} from './adjust'
import { isQuestionShown, setupQuestion } from './questions'
import { recommend, setupTexts, terminologyProfileOf } from './recommend'
import { drawShuffled, drawWalk } from './test/walks'
import { normalizeAnswers, parseSetupAnswers, setupProgress } from './walk'

// Invariants of docs/PRODUCT.md §6.10 over every valid answer walk generated from the question data.

const RUNS = { numRuns: 500 }
const byId = new Map(MODULES.map((m) => [m.id, m]))
const CORE_SWITCHED_OFF: readonly ModuleId[] = ['materials', 'purchases', 'customers', 'payments']
const ITEMS: SetupItem[] = [
  ...CAPABILITY_KEYS.map((key): SetupItem => ({ kind: 'capability', key })),
  ...MODULE_IDS.filter((id) => !ALWAYS_ENABLED_MODULE_IDS.includes(id)).map((id): SetupItem => ({
    kind: 'module',
    id,
  })),
]

function inBothLanguages(key: string): boolean {
  return hasMessage('en', key) && hasMessage('ar', key)
}

describe('recommend() over every answer walk', () => {
  it('accepts every walk as complete, canonical answers with 5–10 questions (11)', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const answers = drawWalk(g)
        const normalized = normalizeAnswers(answers)
        expect(normalized.complete).toBe(true)
        expect(normalized.answers).toEqual(answers)
        expect(parseSetupAnswers(answers)).toEqual({ ok: true, answers })
        expect(normalized.shown.length).toBeGreaterThanOrEqual(5)
        expect(normalized.shown.length).toBeLessThanOrEqual(10)
      }),
      RUNS,
    )
  })

  it('meets invariants 1–10 and 12', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const answers = drawWalk(g)
        const rec = recommend(answers)
        const on = new Set(rec.modules.map((m) => m.id))
        const what = answers.what_you_do

        // Deterministic, in MODULE_IDS order, without duplicates.
        expect(recommend(answers)).toEqual(rec)
        expect(rec.modules.map((m) => m.id)).toEqual(MODULE_IDS.filter((id) => on.has(id)))

        // 1–3: always-on modules, closed under deps, required capabilities on.
        for (const id of ALWAYS_ENABLED_MODULE_IDS) expect(on.has(id)).toBe(true)
        for (const id of on) {
          const m = byId.get(id)!
          for (const dep of m.deps) expect(on.has(dep), `${id} → ${dep}`).toBe(true)
          for (const cap of m.requiresCapabilities) {
            const value =
              cap === 'vat_registered'
                ? rec.vatRegistered === true
                : rec.capabilities[cap as keyof typeof rec.capabilities]
            expect(value, `${id} needs ${cap}`).toBe(true)
          }
        }
        expect(isValidSetupState(recommendedState(rec))).toBe(true)

        // 4: only four core modules are ever switched off.
        for (const m of MODULES.filter((x) => x.kind === 'core' && !on.has(x.id))) {
          expect(CORE_SWITCHED_OFF).toContain(m.id)
        }

        // 5: materials and purchases follow usesMaterials; stock and waste follow keeps_stock.
        const usesMaterials =
          sellsOrMakes(answers) ||
          has(answers.work_setup, 'materials') ||
          has(answers.work_setup, 'stock')
        expect(on.has('materials')).toBe(usesMaterials)
        expect(on.has('purchases')).toBe(usesMaterials)
        expect(on.has('inventory')).toBe(rec.capabilities.keeps_stock)
        expect(on.has('usage_waste')).toBe(rec.capabilities.keeps_stock)

        // 6: customers and payments exactly when a selling module is on.
        const sells = ['orders', 'quotations', 'invoices', 'projects'].some((id) =>
          on.has(id as ModuleId),
        )
        expect(on.has('customers')).toBe(sells)
        expect(on.has('payments')).toBe(sells)

        // 7: no Orders with a POS or without goods; food never asks how or gets jobs.
        const hasGoods = (what ?? []).some((v) => v !== 'services' && v !== 'projects')
        if (rec.capabilities.sells_via_pos || !hasGoods) expect(on.has('orders')).toBe(false)
        if (has(what, 'food_drinks')) {
          expect(isQuestionShown(setupQuestion('how_you_make'), answers)).toBe(false)
          expect(rec.capabilities.jobs_and_tasks).toBe(false)
        }

        // 8: the profile follows the type. 9: exactly the stored capabilities.
        expect(rec.terminologyProfile).toBe(terminologyProfileOf(rec.businessType))
        expect(Object.keys(rec.capabilities)).toEqual([...STORED_CAPABILITY_KEYS])

        // 10: every key it hands out exists in both languages.
        const keys = [
          ...rec.modules.map((m) => m.reason),
          ...rec.offNotes.map((m) => m.reason),
          rec.defaultLocationNameKey,
          ...(rec.jobsReason ? [rec.jobsReason] : []),
        ]
        for (const key of keys) expect(inBothLanguages(key), key).toBe(true)

        // 12: the order inside multi answers never matters.
        expect(recommend(drawShuffled(g, answers))).toEqual(rec)
      }),
      RUNS,
    )
  })

  it('counts progress down only and ends at n = m = the questions shown (14)', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const answers = drawWalk(g)
        const { shown } = normalizeAnswers(answers)
        expect(setupProgress({}, 'what_you_do').m).toBe(SETUP_QUESTION_IDS.length)
        let previous = Number.POSITIVE_INFINITY
        const partial: Record<string, unknown> = {}
        shown.forEach((id, index) => {
          const progress = setupProgress(partial as SetupAnswers, id)
          expect(progress.m).toBeLessThanOrEqual(previous)
          expect(progress.n).toBe(index + 1)
          previous = progress.m
          partial[id] = answers[id]
        })
        const last = shown.at(-1)!
        const beforeLast = Object.fromEntries(
          Object.entries(answers).filter(([id]) => id !== last),
        ) as SetupAnswers
        expect(setupProgress(beforeLast, last)).toMatchObject({
          n: shown.length,
          m: shown.length,
        })
      }),
      RUNS,
    )
  })
})

describe('applyAdjustments over every walk (13)', () => {
  it('keeps invariants 1–3 and changes VAT only by its own adjustment', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const rec = recommend(drawWalk(g))
        const chosen = g(fc.subarray, ITEMS)
        const adj: SetupAdjustments = {
          capabilities: chosen.flatMap((i) =>
            i.kind === 'capability' ? [{ key: i.key, enabled: g(fc.boolean) }] : [],
          ),
          modules: chosen.flatMap((i) =>
            i.kind === 'module' ? [{ id: i.id, enabled: g(fc.boolean) }] : [],
          ),
        }
        const result = applyAdjustments(rec, adj)
        if (!result.ok) {
          // Only a module that needs VAT while VAT stays off is refused.
          expect(result.issue).toBe('needs_vat')
          return
        }
        expect(isValidSetupState(result.state)).toBe(true)
        const vat = adj.capabilities.find((c) => c.key === 'vat_registered')
        expect(result.state.vatRegistered).toBe(vat ? vat.enabled : rec.vatRegistered === true)
      }),
      RUNS,
    )
  })

  it('gives the recommendation back when a capability is switched off and on again', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const rec = recommend(drawWalk(g))
        const base = recommendedState(rec)
        for (const key of CAPABILITY_KEYS) {
          const item: SetupItem = { kind: 'capability', key }
          if (!isSetupItemOn(base, item)) continue
          const off = toggleSetupItem(rec, NO_ADJUSTMENTS, item, false)
          if (!off.ok) throw new Error(off.issue)
          const on = toggleSetupItem(rec, off.adjustments, item, true)
          expect(on.ok && on.state, key).toEqual(base)
        }
      }),
      RUNS,
    )
  })

  it('writes review texts for the current switches that never contradict them', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const answers = drawWalk(g)
        const rec = recommend(answers)
        const base = setupTexts(answers, rec, recommendedState(rec))
        expect(Object.fromEntries(base.reasons)).toEqual(
          Object.fromEntries(
            rec.modules
              .filter((m) => !ALWAYS_ENABLED_MODULE_IDS.includes(m.id))
              .map((m) => [m.id, m.reason]),
          ),
        )
        expect(Object.fromEntries(base.offNotes)).toEqual(
          Object.fromEntries(rec.offNotes.map((m) => [m.id, m.reason])),
        )

        let adj: SetupAdjustments = NO_ADJUSTMENTS
        let state = recommendedState(rec)
        for (const item of g(fc.array, fc.constantFrom(...ITEMS), { maxLength: 6 })) {
          const result = toggleSetupItem(rec, adj, item, !isSetupItemOn(state, item))
          if (!result.ok) continue
          adj = result.adjustments
          state = result.state
        }
        const { reasons, offNotes } = setupTexts(answers, rec, state)
        const texts = new Set([...reasons.values(), ...offNotes.values()])
        const pos = state.capabilities.sells_via_pos
        const saying = (k: string) => texts.has(k as never)
        if (saying('setup.reason.invoices.vat')) expect(state.vatRegistered).toBe(true)
        if (saying('setup.note.invoices.pos_off')) expect(pos && state.vatRegistered).toBe(true)
        if (saying('setup.note.orders.outside_pos')) expect(pos).toBe(true)
        if (saying('setup.reason.sales.pos') || saying('setup.reason.sales.pos_apps')) {
          expect(pos).toBe(true)
        }
        if (saying('setup.reason.orders.shop_no_pos')) expect(pos).toBe(false)
        if (saying('setup.reason.cost_engine.jobs')) {
          expect(state.capabilities.jobs_and_tasks).toBe(true)
        }
        if (saying('setup.reason.cost_engine.solo')) expect(state.capabilities.has_team).toBe(false)
        if (saying('setup.reason.sales.with_orders')) expect(state.modules.has('orders')).toBe(true)
        if (saying('setup.reason.invoices.projects')) {
          expect(state.modules.has('projects')).toBe(true)
        }
      }),
      RUNS,
    )
  })

  it('reproduces every sequence of review toggles from the adjustments it returns', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const rec = recommend(drawWalk(g))
        let adj: SetupAdjustments = { modules: [], capabilities: [] }
        let state = recommendedState(rec)
        const steps = g(fc.array, fc.constantFrom(...ITEMS), { maxLength: 8 })
        for (const item of steps) {
          const enabled = !isSetupItemOn(state, item)
          const result = toggleSetupItem(rec, adj, item, enabled)
          if (!result.ok) {
            expect(result.issue).toBe('needs_vat')
            continue
          }
          expect(isSetupItemOn(result.state, item)).toBe(enabled)
          expect(isValidSetupState(result.state)).toBe(true)
          if (!(item.kind === 'capability' && item.key === 'vat_registered')) {
            expect(result.state.vatRegistered).toBe(state.vatRegistered)
          }
          const replay = applyAdjustments(rec, result.adjustments)
          expect(replay.ok && replay.state).toEqual(result.state)
          expect(applyAdjustments(rec, adjustmentsFor(rec, result.state))).toEqual({
            ok: true,
            state: result.state,
          })
          adj = result.adjustments
          state = result.state
        }
      }),
      { numRuns: 300 },
    )
  })
})
