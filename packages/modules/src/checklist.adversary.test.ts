import { can, OWNER_TEMPLATE_KEY, resolveEffective, visibleCategories } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_KEYS, type Capabilities } from './capabilities'
import { costStepIds, costSteps, type CostFacts } from './checklist'
import { businessStateOf, toggleBusinessItem } from './customize'
import type { ModuleId } from './manifests'
import { PERMISSION_CATALOG, type PermissionKey } from './permissions'
import { roleTemplateByKey } from './role-templates'

// ADVERSARY (M3 Step 6, Release A): Customize BizCost turning a module off mid-use. PRODUCT.md §10:
// "with Sales and Reports on, every member with a sales step sees 'Let's calculate your first real
// profit' …; without them, the M2 checklist". Since the release removed `salesServed` (D-275), the
// sales steps follow each module alone:
//   - Sales switched off (Orders goes with it, D-275) leaves Reports on (no deps), so the owner keeps
//     "See your real profit", titled "Let's calculate your first real profit" (leadsToProfit). With no
//     sale yet it can never be done: nothing in Release A can finalize a sale with Sales and Orders
//     off, so the checklist stays at "n − 1 of n" for good and "Your real profit is ready" never comes.
//   - Reports switched off leaves "Add or import your sales", so the checklist is titled "Let's
//     calculate your first real profit" ("BizCost works out what you really earn") in a business where
//     nobody can see real profit (profit.summary and the profit cards need Reports).

const ALL_OFF = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]))

function accessOf(templateKey: string, active: (id: ModuleId) => boolean) {
  const effective = resolveEffective({
    roleTemplateKey: templateKey,
    rolePermissionKeys: roleTemplateByKey(templateKey)?.permissionKeys ?? [],
    overrides: [],
    catalog: PERMISSION_CATALOG,
  })
  return {
    active,
    can: (key: PermissionKey) => can(effective, key),
    visible: visibleCategories(effective),
    capabilities: ALL_OFF,
  }
}

/** A business with every released module on, then one switch flipped as Customize BizCost does. */
function activeAfterSwitchingOff(id: ModuleId): (module: ModuleId) => boolean {
  const everything = businessStateOf({
    enabledModules: [
      'products',
      'materials',
      'suppliers',
      'purchases',
      'expenses',
      'running_costs',
      'files',
      'cost_engine',
      'sales',
      'orders',
      'customers',
      'payments',
      'reports',
    ],
    capabilities: ALL_OFF as unknown as Capabilities,
  })
  const result = toggleBusinessItem(everything, { kind: 'module', id }, false)
  if (!result.ok) throw new Error(result.issue)
  return (module) => result.state.modules.has(module)
}

/** Every step done, with nothing sold yet (no finalized sale, so none with a complete cost). */
const EVERYTHING_BUT_SALES: CostFacts = {
  items: 3,
  madeProducts: 2,
  madeWithoutRecipe: 0,
  usedMaterials: 4,
  unpricedMaterials: 0,
  runningCostsEntered: true,
  hourlyRateSet: true,
  itemsWithMinutes: 2,
  incompleteCosts: 0,
  finalizedSales: 0,
  completeSales: 0,
}

describe('the way to the first real profit after Customize BizCost turns a module off (PRODUCT.md §10)', () => {
  it('Sales off (and Orders with it): no "See your real profit" that nothing can complete', () => {
    const active = activeAfterSwitchingOff('sales')
    // The switch as Customize BizCost applies it: Orders goes with Sales, Reports stays on.
    expect(active('sales')).toBe(false)
    expect(active('orders')).toBe(false)
    expect(active('reports')).toBe(true)

    const ids = costStepIds(accessOf(OWNER_TEMPLATE_KEY, active))
    const steps = costSteps(ids, EVERYTHING_BUT_SALES)
    const open = steps.filter((step) => !step.done).map((step) => step.id)
    // Found: ['real_profit'], open for good (no sale can be finalized with Sales and Orders off).
    expect(open, `steps: ${ids.join(', ')}`).toEqual([])
    expect(ids).not.toContain('real_profit')
  })

  it('Reports off: the M2 checklist, not "Let\'s calculate your first real profit"', () => {
    const active = activeAfterSwitchingOff('reports')
    expect(active('sales')).toBe(true)
    expect(active('reports')).toBe(false)
    for (const template of [OWNER_TEMPLATE_KEY, 'manager', 'employee']) {
      const ids = costStepIds(accessOf(template, active))
      // leadsToProfit (the web's title) is true with either sales step.
      expect(
        ids.filter((id) => id === 'sales' || id === 'real_profit'),
        template,
      ).toEqual([])
    }
  })
})
