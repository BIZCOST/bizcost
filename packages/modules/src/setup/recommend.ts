import type { BusinessType, TerminologyProfile } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { STORED_CAPABILITY_KEYS, type StoredCapabilityKey } from '../capabilities'
import { ALWAYS_ENABLED_MODULE_IDS, MODULE_IDS, type ModuleId } from '../manifests'
import { has, sellsOrMakes, type SetupAnswers, type Workplace } from './answers'
import { normalizeAnswers } from './walk'

// recommend() (docs/PRODUCT.md §6.4–§6.6): pure, deterministic and total. The server recomputes it from
// the submitted answers and never trusts a client-computed result.

export type LocationKind = 'home' | 'shop' | 'office' | 'workshop' | 'site'

export interface ModuleReason {
  readonly id: ModuleId
  /** `setup.reason.<module>.<variant>`, or an off note `setup.note.<module>.<variant>`. */
  readonly reason: I18nKey
}

export interface Recommendation {
  readonly businessType: BusinessType
  readonly terminologyProfile: TerminologyProfile
  /** Every stored capability (vat_registered lives on businesses, D-052). */
  readonly capabilities: Readonly<Record<StoredCapabilityKey, boolean>>
  /** null = "Not sure": stored as false, the review shows a note. */
  readonly vatRegistered: boolean | null
  /** The ON set in MODULE_IDS order, closed under deps; Dashboard and Settings always. */
  readonly modules: readonly ModuleReason[]
  /** Off modules with a specific note (review only). */
  readonly offNotes: readonly ModuleReason[]
  /** Reason of the "cost of each job" row (review only). */
  readonly jobsReason: I18nKey | null
  readonly defaultLocationKind: LocationKind
  /** Name of the default location for the recommended multi_location. */
  readonly defaultLocationNameKey: I18nKey
}

const key = (value: string) => value as I18nKey

/** The facts every rule reads (§6.4), from normalized answers. */
interface Facts {
  readonly a: SetupAnswers
  readonly sellsOrMakes: boolean
  /** An option other than services and projects: the gate for Orders. */
  readonly hasGoods: boolean
  readonly usesMaterials: boolean
  readonly keepsStock: boolean
  readonly usesMachines: boolean
  readonly hasTeam: boolean
  readonly multiLocation: boolean
  readonly sellsViaPos: boolean
  readonly customOnly: boolean
  readonly jobsAndTasks: boolean
  readonly vatRegistered: boolean | null
}

function factsOf(a: SetupAnswers): Facts {
  const what = a.what_you_do ?? []
  const how = a.how_you_make ?? []
  const usesMaterials =
    sellsOrMakes(a) || has(a.work_setup, 'materials') || has(a.work_setup, 'stock')
  const usesMachines = has(a.work_setup, 'machines')
  return {
    a,
    sellsOrMakes: sellsOrMakes(a),
    hasGoods: what.some((v) => v !== 'services' && v !== 'projects'),
    usesMaterials,
    keepsStock: has(a.work_setup, 'stock'),
    usesMachines,
    hasTeam: a.team === 'team',
    multiLocation: a.branches === true,
    sellsViaPos: a.pos === true,
    customOnly: how.length === 1 && how[0] === 'custom_jobs',
    // The second branch covers service workshops (garage, phone repair, print shop): never a
    // freelancer without materials or machines, never food, never a project company.
    jobsAndTasks:
      has(a.how_you_make, 'custom_jobs') ||
      (has(a.what_you_do, 'services') &&
        !has(a.what_you_do, 'food_drinks') &&
        !has(a.what_you_do, 'projects') &&
        has(a.sales_channels, 'quotes') &&
        (usesMaterials || usesMachines)),
    vatRegistered: a.vat === 'yes' ? true : a.vat === 'no' ? false : null,
  }
}

const PROFILE_OF: Readonly<Record<BusinessType, TerminologyProfile>> = {
  food: 'food',
  factory: 'factory',
  workshop: 'workshop',
  projects: 'projects',
  maker: 'maker',
  retail: 'general',
  services: 'general',
  other: 'general',
}

/** The terminology profile of a business type (§6.4). */
export function terminologyProfileOf(type: BusinessType): TerminologyProfile {
  return PROFILE_OF[type]
}

/** Business type = the first match (§6.4). */
function businessTypeOf(f: Facts): BusinessType {
  const { a } = f
  const makes = has(a.what_you_do, 'make_products')
  if (has(a.what_you_do, 'food_drinks')) return 'food'
  if (makes && (has(a.how_you_make, 'batches') || a.workplace === 'factory')) return 'factory'
  if (
    makes &&
    has(a.how_you_make, 'custom_jobs') &&
    (!has(a.how_you_make, 'catalog') || a.workplace === 'workshop')
  ) {
    return 'workshop'
  }
  if (has(a.what_you_do, 'projects')) return 'projects'
  if (makes) return 'maker'
  if (f.jobsAndTasks) return 'workshop'
  if (has(a.what_you_do, 'sell_products')) return 'retail'
  if (has(a.what_you_do, 'services')) return 'services'
  return 'other'
}

const LOCATION_KIND: Readonly<Record<Workplace, LocationKind>> = {
  home: 'home',
  shop: 'shop',
  office: 'office',
  workshop: 'workshop',
  factory: 'workshop',
  kitchen: 'workshop',
  customer_sites: 'site',
}

export function locationKindOf(workplace: Workplace): LocationKind {
  return LOCATION_KIND[workplace]
}

/**
 * Name of the default location (`setup.location.<workplace>` or `…_main` with more than one branch),
 * written in the user's language when the business is created. Uses the final multi_location.
 */
export function locationNameKey(workplace: Workplace, multiLocation: boolean): I18nKey {
  return key(`setup.location.${workplace}${multiLocation ? '_main' : ''}`)
}

/** Which modules are on (§6.6). Optional modules first: customers and payments follow them. */
function onModules(f: Facts): ReadonlySet<ModuleId> {
  const { a } = f
  const ch = a.sales_channels ?? []
  const on = new Set<ModuleId>(ALWAYS_ENABLED_MODULE_IDS)
  const add = (id: ModuleId, when: boolean) => {
    if (when) on.add(id)
  }
  add(
    'orders',
    f.hasGoods &&
      !f.sellsViaPos &&
      (ch.includes('messages') || ch.includes('invoice_later') || ch.includes('walk_in')),
  )
  add('quotations', has(a.what_you_do, 'projects') || ch.includes('quotes'))
  add('projects', has(a.what_you_do, 'projects'))
  add(
    'invoices',
    on.has('quotations') ||
      on.has('projects') ||
      ch.includes('invoice_later') ||
      (f.vatRegistered === true && on.has('orders')),
  )
  const sells = on.has('orders') || on.has('quotations') || on.has('invoices') || on.has('projects')
  // Core modules: on unless switched off; recommend() switches off only these four.
  add('products', true)
  add('materials', f.usesMaterials)
  add('suppliers', true)
  add('purchases', f.usesMaterials)
  add('expenses', true)
  add('running_costs', true)
  add('files', true)
  add('cost_engine', true)
  add('customers', sells)
  add('sales', true)
  add('payments', sells)
  add('reports', true)
  add('inventory', f.keepsStock)
  add('usage_waste', f.keepsStock)
  add('employees', f.hasTeam)
  add('attendance', has(a.team_tracking, 'hours'))
  add('payroll', has(a.team_tracking, 'salaries'))
  add('equipment', f.usesMachines)
  add('vehicles', has(a.work_setup, 'vehicles'))
  add('petty_cash', has(a.team_tracking, 'staff_cash'))
  add('vat_center', f.vatRegistered === true)
  return on
}

type ReasonRule = readonly [variant: string, when: (f: Facts, on: ReadonlySet<ModuleId>) => boolean]

const always = () => true
const DEFAULT: readonly ReasonRule[] = [['default', always]]

/** Reason variants per module; the first match wins (§6.6). Keys `setup.reason.<module>.<variant>`. */
const REASON_RULES: Readonly<Record<ModuleId, readonly ReasonRule[]>> = {
  dashboard: [],
  settings: [],
  products: [
    ['projects', (f) => has(f.a.what_you_do, 'projects') && !f.sellsOrMakes],
    ['services', (f) => has(f.a.what_you_do, 'services') && !f.sellsOrMakes],
    ['custom', (f) => f.customOnly],
    ['default', always],
  ],
  materials: [
    ['food', (f) => has(f.a.what_you_do, 'food_drinks')],
    ['make', (f) => has(f.a.what_you_do, 'make_products')],
    ['resell', (f) => has(f.a.what_you_do, 'sell_products')],
    ['uses', always],
  ],
  suppliers: [
    ['no_purchases', (f) => !f.usesMaterials],
    ['projects', (f) => has(f.a.what_you_do, 'projects')],
    ['default', always],
  ],
  purchases: DEFAULT,
  expenses: DEFAULT,
  running_costs: [
    ['home', (f) => f.a.workplace === 'home'],
    ['default', always],
  ],
  files: DEFAULT,
  cost_engine: [
    ['jobs', (f) => f.jobsAndTasks],
    ['solo', (f) => !f.hasTeam],
    ['default', always],
  ],
  customers: DEFAULT,
  sales: [
    ['pos_apps', (f) => f.sellsViaPos && has(f.a.sales_channels, 'online')],
    ['pos', (f) => f.sellsViaPos],
    ['apps', (f) => has(f.a.sales_channels, 'online')],
    ['with_orders', (_, on) => on.has('orders')],
    ['invoices', (_, on) => on.has('invoices')],
    ['default', always],
  ],
  payments: [
    ['projects', (_, on) => on.has('projects')],
    ['deposits', (f) => has(f.a.how_you_make, 'custom_jobs')],
    ['orders', (_, on) => on.has('orders')],
    ['default', always],
  ],
  reports: [
    ['projects', (_, on) => on.has('projects')],
    ['default', always],
  ],
  orders: [
    ['invoice_later', (f) => has(f.a.sales_channels, 'invoice_later')],
    ['custom_jobs', (f) => f.customOnly],
    ['messages', (f) => has(f.a.sales_channels, 'messages')],
    // Walk-in customers and no POS (recommend() turns Orders on only without a POS; the review can
    // turn the POS on, and then no variant fits).
    ['shop_no_pos', (f) => !f.sellsViaPos],
  ],
  quotations: [
    ['projects', (f) => has(f.a.what_you_do, 'projects')],
    ['quotes', always],
  ],
  invoices: [
    ['projects', (_, on) => on.has('projects')],
    ['vat', (f) => f.vatRegistered === true],
    ['quotes', (_, on) => on.has('quotations')],
    ['default', always],
  ],
  inventory: DEFAULT,
  usage_waste: [
    ['make', (f) => has(f.a.what_you_do, 'make_products') && !has(f.a.what_you_do, 'food_drinks')],
    [
      'resell',
      (f) =>
        has(f.a.what_you_do, 'sell_products') &&
        !has(f.a.what_you_do, 'make_products') &&
        !has(f.a.what_you_do, 'food_drinks'),
    ],
    ['default', always],
  ],
  employees: DEFAULT,
  attendance: DEFAULT,
  payroll: DEFAULT,
  equipment: DEFAULT,
  vehicles: DEFAULT,
  projects: DEFAULT,
  petty_cash: DEFAULT,
  vat_center: DEFAULT,
}

/** The reason variants of each module, in rule order (every `setup.reason.<module>.<variant>` key). */
export const REASON_VARIANTS: Readonly<Record<ModuleId, readonly string[]>> = Object.fromEntries(
  MODULE_IDS.map((id) => [id, REASON_RULES[id].map(([variant]) => variant)]),
) as unknown as Record<ModuleId, readonly string[]>

/** Reason of Dashboard and Settings (never displayed). */
export const ALWAYS_ON_REASON = key('setup.reason.always')

/** The first variant that fits, or null. */
function matchReason(id: ModuleId, f: Facts, on: ReadonlySet<ModuleId>): I18nKey | null {
  const rule = REASON_RULES[id].find(([, when]) => when(f, on))
  return rule ? key(`setup.reason.${id}.${rule[0]}`) : null
}

function reasonOf(id: ModuleId, f: Facts, on: ReadonlySet<ModuleId>): I18nKey {
  if (ALWAYS_ENABLED_MODULE_IDS.includes(id)) return ALWAYS_ON_REASON
  const reason = matchReason(id, f, on)
  if (!reason) throw new Error(`no reason for ${id}`)
  return reason
}

function offNotesOf(f: Facts, on: ReadonlySet<ModuleId>): ModuleReason[] {
  const notes: ModuleReason[] = []
  if (f.hasGoods && f.sellsViaPos && has(f.a.sales_channels, 'messages') && !on.has('orders')) {
    notes.push({ id: 'orders', reason: key('setup.note.orders.outside_pos') })
  }
  if (f.sellsViaPos && f.vatRegistered === true && !on.has('invoices')) {
    notes.push({ id: 'invoices', reason: key('setup.note.invoices.pos_off') })
  }
  return notes
}

function jobsReasonOf(f: Facts): I18nKey | null {
  if (has(f.a.how_you_make, 'custom_jobs')) return key('setup.jobs.reason.custom_jobs')
  if (has(f.a.what_you_do, 'services')) return key('setup.jobs.reason.services')
  return null
}

/**
 * The recommended setup for a set of answers (§6.4). Answers are normalized first (hidden answers
 * are ignored); the server passes answers that parseSetupAnswers() accepted. Total: a missing
 * workplace counts as home.
 */
export function recommend(answers: SetupAnswers): Recommendation {
  const f = factsOf(normalizeAnswers(answers).answers)
  const on = onModules(f)
  const businessType = businessTypeOf(f)
  const capabilities: Record<StoredCapabilityKey, boolean> = {
    has_team: f.hasTeam,
    multi_location: f.multiLocation,
    keeps_stock: f.keepsStock,
    uses_machines: f.usesMachines,
    sells_via_pos: f.sellsViaPos,
    jobs_and_tasks: f.jobsAndTasks,
  }
  const workplace = f.a.workplace ?? 'home'
  return {
    businessType,
    terminologyProfile: terminologyProfileOf(businessType),
    capabilities: Object.fromEntries(
      STORED_CAPABILITY_KEYS.map((k) => [k, capabilities[k]]),
    ) as Record<StoredCapabilityKey, boolean>,
    vatRegistered: f.vatRegistered,
    modules: MODULE_IDS.filter((id) => on.has(id)).map((id) => ({
      id,
      reason: reasonOf(id, f, on),
    })),
    offNotes: offNotesOf(f, on),
    jobsReason: jobsReasonOf(f),
    defaultLocationKind: locationKindOf(workplace),
    defaultLocationNameKey: locationNameKey(workplace, f.multiLocation),
  }
}

/** What the review's texts read besides the answers: the current switches (a SetupState). */
export interface ReviewedSetup {
  readonly capabilities: Readonly<Record<StoredCapabilityKey, boolean>>
  readonly vatRegistered: boolean
  /** Modules that are on. */
  readonly modules: ReadonlySet<ModuleId>
}

export interface SetupTexts {
  /**
   * Reasons of the modules recommend() turned on, read with the current switches; a module without a
   * fitting variant any more (e.g. Orders' "no POS in your shop" once the POS is on) has none.
   */
  readonly reasons: ReadonlyMap<ModuleId, I18nKey>
  /** Off notes of the modules that are off. */
  readonly offNotes: ReadonlyMap<ModuleId, I18nKey>
}

/**
 * The review's reasons and off notes (§6.6–§6.7) for the current switches: the rules of recommend(),
 * with the answers' facts overlaid by the capabilities, VAT and modules the user switched, so no row
 * says the opposite of a statement (e.g. "registered for VAT" once VAT is off). For the recommended
 * state they are recommend()'s own reasons and notes.
 */
export function setupTexts(
  answers: SetupAnswers,
  rec: Recommendation,
  state: ReviewedSetup,
): SetupTexts {
  const f: Facts = {
    ...factsOf(normalizeAnswers(answers).answers),
    // Materials and Purchases are on exactly when usesMaterials in the recommendation (§6.10, 5).
    usesMaterials: state.modules.has('purchases'),
    hasTeam: state.capabilities.has_team,
    multiLocation: state.capabilities.multi_location,
    keepsStock: state.capabilities.keeps_stock,
    usesMachines: state.capabilities.uses_machines,
    sellsViaPos: state.capabilities.sells_via_pos,
    jobsAndTasks: state.capabilities.jobs_and_tasks,
    vatRegistered: state.vatRegistered,
  }
  const reasons = new Map<ModuleId, I18nKey>()
  for (const { id } of rec.modules) {
    if (ALWAYS_ENABLED_MODULE_IDS.includes(id)) continue
    const reason = matchReason(id, f, state.modules)
    if (reason) reasons.set(id, reason)
  }
  const offNotes = new Map(offNotesOf(f, state.modules).map((n) => [n.id, n.reason]))
  return { reasons, offNotes }
}
