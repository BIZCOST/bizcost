import { FIELD_WRAPPER_TYPES, type AppErrorCode } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { QUESTION_SET_VERSION } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appRouter } from '../../src'
import { query } from '../helpers'
import { randomToken, WORKSHOP } from '../settings'
import {
  callProcedure,
  createTenant,
  leaksOf,
  openApi,
  proceduresOf,
  tenantDigest,
  type Api,
  type Base,
  type Person,
  type ProcedureInfo,
  type Tenant,
} from './fixture'

// Cross-tenant attack matrix (ROADMAP.md Step 9; ARCHITECTURE.md §Testing & CI, Cross-tenant attacks).
// Two businesses, each with its owner, an Admin and an Employee. For EVERY procedure of appRouter,
// walked from the router:
//   - business procedures: each member of the attacking business calls it with x-business-id of the
//     victim (and the victim's ids in the input): FORBIDDEN, with nothing of the victim in the answer;
//   - business procedures whose input names rows: the attacker's owner calls it in their OWN business
//     with the victim's ids: refused (NOT_FOUND, CONFLICT, VALIDATION…), nothing of the victim;
//   - authed and public procedures: called by the attacker (also with the victim's x-business-id,
//     which they must ignore) and with the victim's ids where the input takes them: the expected
//     answer, and nothing of the victim;
// and both ways (A attacks B, B attacks A). Last, the victim's rows, audit log, profiles and Storage
// objects are exactly as before.
//
// PROBES classifies every procedure with the reason it is safe. A procedure added without a probe
// fails the first test, and a probe whose input references rows (ids, paths, tokens) must say how the
// victim's reference is refused.

interface Variant {
  input: unknown
  /** Business procedures: the answers accepted when the attacker sends it in their own business. */
  own?: readonly AppErrorCode[]
}

interface Probe {
  base: Base
  reason: string
  /** Valid inputs, naming the victim's rows where the input takes a reference. */
  variants?: (victim: Tenant, attacker: Tenant) => Variant[]
  /** Authed and public procedures: the attacker's answer ('ok': served, with nothing of the victim). */
  answer?: 'ok' | readonly AppErrorCode[]
  /** Input fields that look like references (by name or format) but name no row: path → why. */
  notReferences?: Record<string, string>
}

const NO_ROWS = 'names no rows: it acts on the x-business-id business, which businessScoped checks'

const PROBES: Record<string, Probe> = {
  health: { base: 'public', reason: 'liveness and region only', answer: 'ok' },
  me: {
    base: 'authed',
    reason: 'lists only the caller’s own active memberships (RLS own_memberships)',
    answer: 'ok',
  },
  'account.updateProfile': {
    base: 'authed',
    reason: 'changes only the caller’s own profile and memberships',
    variants: () => [{ input: { displayName: 'Attacker' } }],
    answer: 'ok',
  },
  'account.setLastBusiness': {
    base: 'authed',
    reason: 'only a business the caller is an active member of (D-077)',
    variants: (victim) => [{ input: { businessId: victim.id } }],
    answer: ['forbidden'],
  },
  'account.delete': {
    base: 'authed',
    reason:
      'acts on the caller’s own memberships only; here refused before any change (sole owner)',
    answer: ['sole_owner'],
  },
  'business.createFromSetup': {
    base: 'authed',
    reason: 'an id of a business the caller cannot see is CONFLICT (D-076), never a takeover',
    variants: (victim) => [
      {
        input: {
          businessId: victim.id,
          legalName: 'Takeover',
          locale: 'en',
          questionSetVersion: QUESTION_SET_VERSION,
          answers: WORKSHOP,
          adjustments: { modules: [], capabilities: [] },
        },
      },
    ],
    answer: ['conflict'],
  },
  'invitation.accept': {
    base: 'authed',
    reason: 'needs the invited, verified email; the link alone does not let another account in',
    variants: (victim) => [{ input: { token: victim.invitationToken } }],
    answer: ['invitation_invalid'],
  },
  'invitation.preview': {
    base: 'public',
    reason:
      'the link’s token is its secret: its holder sees the business name by design (D-082); ' +
      'any other token is invitation_invalid',
    variants: () => [{ input: { token: randomToken() } }],
    answer: ['invitation_invalid'],
  },

  'business.context': { base: 'business', reason: NO_ROWS },
  'business.profile': { base: 'business', reason: NO_ROWS },
  'business.updateProfile': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [
      {
        input: {
          version: 1,
          legalName: 'Pwned',
          legalNameAr: null,
          vatRegistered: false,
          trn: null,
        },
      },
    ],
  },
  'business.setDefaultLocale': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [{ input: { defaultLocale: 'ar' } }],
  },
  'business.logoUploadUrl': {
    base: 'business',
    reason: 'the path is made by the server under the x-business-id business',
    variants: () => [{ input: { contentType: 'image/png' } }],
  },
  'business.setLogo': {
    base: 'business',
    reason: 'only a logo path of the x-business-id business that it issued (D-085)',
    variants: (victim) => [
      { input: { path: victim.logoPath }, own: ['validation'] },
      { input: { path: victim.openUpload.path }, own: ['validation'] },
    ],
  },
  'business.removeLogo': { base: 'business', reason: NO_ROWS },
  'business.customization': { base: 'business', reason: NO_ROWS },
  'business.customize': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [{ input: { item: { kind: 'capability', key: 'has_team' }, enabled: false } }],
    notReferences: {
      'item.id':
        'a module key of the registry (e.g. "orders"), the same in every business, not a row; ' +
        'an unknown key is VALIDATION',
    },
  },
  'dashboard.checklist': { base: 'business', reason: NO_ROWS },
  'location.list': { base: 'business', reason: NO_ROWS },
  'location.create': {
    base: 'business',
    reason: 'an id already used anywhere is CONFLICT (insertIdempotent), the row is never read',
    variants: (victim) => [{ input: { id: victim.branch.id, name: 'Pwned' }, own: ['conflict'] }],
  },
  'location.rename': {
    base: 'business',
    reason: 'looked up in the x-business-id business (RLS and business_id filter)',
    variants: (victim) => [
      {
        input: { id: victim.branch.id, name: 'Pwned', version: victim.branch.version },
        own: ['not_found'],
      },
    ],
  },
  'location.setDefault': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.branch.id }, own: ['not_found'] }],
  },
  'location.remove': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.branch.id }, own: ['not_found'] }],
  },
  'member.list': { base: 'business', reason: NO_ROWS },
  'member.changeRole': {
    base: 'business',
    reason: 'member and role are both looked up in the x-business-id business',
    variants: (victim, attacker) => [
      {
        input: { memberId: victim.employeeMemberId, roleId: victim.roles.manager.id },
        own: ['not_found'],
      },
      // Own member, the victim's role: composite (business_id, role_id) keys, and the lookup.
      {
        input: { memberId: attacker.employeeMemberId, roleId: victim.roles.admin.id },
        own: ['not_found'],
      },
    ],
  },
  'member.remove': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { memberId: victim.employeeMemberId }, own: ['not_found'] }],
  },
  'member.leave': {
    base: 'business',
    reason: 'leaves the x-business-id business only, as its member',
  },
  'member.transferOwnership': {
    base: 'business',
    reason: 'the new owner is looked up in the x-business-id business',
    variants: (victim) => [{ input: { memberId: victim.adminMemberId }, own: ['not_found'] }],
  },
  'invitation.list': { base: 'business', reason: NO_ROWS },
  'invitation.create': {
    base: 'business',
    reason: 'the role is looked up in the x-business-id business; a used id is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: newId(),
          email: `x-${newId()}@test.bizcost.local`,
          roleId: victim.roles.employee.id,
          locale: 'en',
        },
        own: ['not_found'],
      },
      {
        input: {
          id: victim.invitation.id,
          email: `x-${newId()}@test.bizcost.local`,
          roleId: attacker.roles.employee.id,
          locale: 'en',
        },
        own: ['conflict'],
      },
    ],
  },
  'invitation.resend': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.invitation.id }, own: ['not_found'] }],
  },
  'invitation.revoke': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.invitation.id }, own: ['not_found'] }],
  },
  'role.list': { base: 'business', reason: NO_ROWS },
  'material.list': {
    base: 'business',
    reason: `${NO_ROWS}; the cursor only positions a page inside that business`,
    variants: () => [{ input: { search: 'milk', status: 'all' } }],
  },
  'material.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.material.id }, own: ['not_found'] }],
  },
  'material.create': {
    base: 'business',
    reason:
      'an id already used anywhere is CONFLICT (the material through insertIdempotent, a unit ' +
      'through its primary key), and a pack may only name a pack of the same material',
    variants: (victim) => [
      {
        input: { id: victim.material.id, name: `Pwned ${newId()}`, unit: 'kg' },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          unit: 'l',
          packs: [{ id: victim.material.packs[0]?.id, name: 'crate', qty: '1', ofUnit: 'l' }],
        },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          unit: 'l',
          packs: [{ id: newId(), name: 'crate', qty: '1', ofPackId: victim.material.packs[0]?.id }],
        },
        own: ['validation'],
      },
    ],
  },
  'material.update': {
    base: 'business',
    reason:
      'the material is looked up in the x-business-id business, a unit it keeps among its own ' +
      'units, and a new unit id used anywhere is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.material.id,
          version: victim.material.version,
          name: 'Pwned',
          unit: 'l',
        },
        own: ['not_found'],
      },
      // Own material, the victim's pack: its id is taken (the transaction rolls back).
      {
        input: {
          id: attacker.material.id,
          version: attacker.material.version,
          name: attacker.material.name,
          unit: 'l',
          packs: [{ id: victim.material.packs[0]?.id, name: 'crate', qty: '1', ofUnit: 'l' }],
        },
        own: ['conflict'],
      },
    ],
  },
  'material.archive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.material.id }, own: ['not_found'] }],
  },
  'material.unarchive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.material.id }, own: ['not_found'] }],
  },
  'product.list': {
    base: 'business',
    reason: `${NO_ROWS}; the cursor only positions a page inside that business`,
    variants: () => [{ input: { search: 'latte', status: 'all' } }],
  },
  'product.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.product.id }, own: ['not_found'] }],
  },
  'product.create': {
    base: 'business',
    reason:
      'an id already used anywhere is CONFLICT (insertIdempotent); its locations are looked up ' +
      'in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.product.id, name: `Pwned ${newId()}`, type: 'product', unit: 'piece' },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          type: 'product',
          unit: 'piece',
          locationIds: [victim.branch.id],
        },
        own: ['not_found'],
      },
    ],
  },
  'product.update': {
    base: 'business',
    reason: 'the record and its locations are looked up in the x-business-id business',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.product.id,
          version: victim.product.version,
          name: 'Pwned',
          type: 'product',
          unit: 'piece',
        },
        own: ['not_found'],
      },
      {
        input: {
          id: attacker.product.id,
          version: attacker.product.version,
          name: attacker.product.name,
          type: 'product',
          unit: 'piece',
          locationIds: [victim.branch.id],
        },
        own: ['not_found'],
      },
    ],
  },
  'product.archive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.product.id }, own: ['not_found'] }],
  },
  'product.unarchive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.product.id }, own: ['not_found'] }],
  },
  'role.updatePermissions': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      {
        input: {
          id: victim.roles.employee.id,
          version: victim.roles.employee.version,
          permissionKeys: ['dashboard.home.view', 'settings.business.view'],
        },
        own: ['not_found'],
      },
    ],
  },
}

// A stand-in tenant for reading the probes' shape before the fixture exists (never sent).
const STUB_FIELD = {
  id: newId(),
  version: 1,
  path: 'stub',
  email: 'stub@test.bizcost.local',
  name: 'stub',
  packs: [{ id: newId(), name: 'stub' }],
}
const STUB = new Proxy({} as Tenant, {
  get: (_target, key) => (key === 'roles' ? new Proxy({}, { get: () => STUB_FIELD }) : STUB_FIELD),
})

const PROCEDURES = proceduresOf(appRouter)
const BUSINESS = PROCEDURES.filter((p) => p.base === 'business')
const OWN_BUSINESS = BUSINESS.filter((p) =>
  probeOf(p)
    .variants?.(STUB, STUB)
    .some((v) => v.own),
)
const OUTSIDE = PROCEDURES.filter((p) => p.base !== 'business')

function probeOf(procedure: ProcedureInfo): Probe {
  const probe = PROBES[procedure.path]
  if (!probe) throw new Error(`${procedure.path} has no probe`)
  return probe
}

/** Field names that name a row or an object (and their plurals, e.g. `locationIds`). */
const REFERENCE_NAME = /^(?:ids?|paths?|tokens?)$|(?:Ids?|Paths?|Tokens?)$/

function isUuidString(def: z.core.$ZodTypeDef): boolean {
  const format = (def as { format?: string }).format
  return def.type === 'string' && (format === 'guid' || format === 'uuid')
}

/**
 * Fields of an input schema that name a row or an object: UUIDs, paths and tokens, by format or by
 * name. Walks inputs the way src/redact.ts walks outputs: object fields (and catchall), array items
 * and record values (`x.*`, a record keyed by UUIDs is a reference itself), tuple items, every union
 * option, both intersection sides, pipes and lazy schemas. A leaf is named by its nearest field.
 */
function referenceFields(
  schema: z.core.$ZodType,
  path: string[] = [],
  seen: Set<z.core.$ZodType> = new Set(),
): string[] {
  const def = schema._zod.def
  const walk = (inner: z.core.$ZodType, at: string[] = path) => referenceFields(inner, at, seen)
  const unique = (paths: string[]) => [...new Set(paths)]
  if (FIELD_WRAPPER_TYPES.has(def.type)) return walk((def as z.core.$ZodOptionalDef).innerType)
  switch (def.type) {
    case 'pipe': {
      const pipe = def as z.core.$ZodPipeDef
      return unique([...walk(pipe.in), ...walk(pipe.out)])
    }
    case 'lazy': {
      if (seen.has(schema)) return []
      seen.add(schema)
      return walk((def as z.core.$ZodLazyDef).getter())
    }
    case 'object': {
      const { shape, catchall } = def as z.core.$ZodObjectDef
      return [
        ...Object.entries(shape).flatMap(([key, field]) => walk(field, [...path, key])),
        ...(catchall ? walk(catchall, [...path, '*']) : []),
      ]
    }
    case 'array':
      return walk((def as z.core.$ZodArrayDef).element, [...path, '*'])
    case 'record': {
      const { keyType, valueType } = def as z.core.$ZodRecordDef
      const keyIsReference = isUuidString(keyType._zod.def) ? [[...path, '*'].join('.')] : []
      return unique([...keyIsReference, ...walk(valueType, [...path, '*'])])
    }
    case 'tuple': {
      const { items, rest } = def as z.core.$ZodTupleDef
      return unique([
        ...items.flatMap((item, index) => walk(item, [...path, String(index)])),
        ...(rest ? walk(rest, [...path, '*']) : []),
      ])
    }
    case 'union':
      return unique((def as z.core.$ZodUnionDef).options.flatMap((option) => walk(option)))
    case 'intersection': {
      const { left, right } = def as z.core.$ZodIntersectionDef
      return unique([...walk(left), ...walk(right)])
    }
  }
  const name = path.findLast((segment) => segment !== '*' && !/^\d+$/.test(segment)) ?? ''
  return isUuidString(def) || REFERENCE_NAME.test(name) ? [path.join('.')] : []
}

function inputSchemaOf(path: string): z.core.$ZodType | undefined {
  const procedures = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { inputs: unknown[] } }
  >
  const procedure = procedures[path]
  return procedure?._def.inputs[0] as z.core.$ZodType | undefined
}

describe('the matrix covers every procedure', () => {
  it('has exactly one probe per procedure of appRouter, with its base and a reason', () => {
    expect(Object.keys(PROBES).sort()).toEqual(PROCEDURES.map((p) => p.path))
    for (const procedure of PROCEDURES) {
      const probe = probeOf(procedure)
      expect(probe.base, procedure.path).toBe(procedure.base)
      expect(probe.reason.length, procedure.path).toBeGreaterThan(10)
      expect(Boolean(probe.variants), `${procedure.path}: an input needs variants`).toBe(
        procedure.takesInput,
      )
      if (procedure.base !== 'business') expect(probe.answer, procedure.path).toBeDefined()
      else expect(probe.answer, procedure.path).toBeUndefined()
    }
  })

  it('the walk finds references inside arrays, records, tuples, unions, intersections and lazy schemas', () => {
    const uuid = z.uuid()
    const node: z.ZodType = z.lazy(() =>
      z.object({ parentId: uuid.optional(), children: z.array(node) }),
    )
    const schema = z.object({
      id: z.string(),
      name: z.string(),
      permissionKeys: z.array(z.string()),
      locationIds: z.array(z.string()),
      lines: z.array(z.object({ productId: z.string(), quantity: z.string() })),
      byMember: z.record(uuid, z.boolean()),
      prices: z.record(z.string(), z.object({ supplierId: uuid.nullable() })),
      pair: z.tuple([z.string(), uuid], z.object({ path: z.string() })),
      item: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), id: z.string() }),
        z.object({ kind: z.literal('b'), token: z.string() }),
      ]),
      both: z.intersection(z.object({ roleId: z.string() }), z.object({ note: z.string() })),
      tree: node,
      raw: z.string().pipe(z.uuid()),
    })
    expect(referenceFields(schema).sort()).toEqual(
      [
        'id',
        'locationIds.*',
        'lines.*.productId',
        'byMember.*',
        'prices.*.supplierId',
        'pair.1',
        'pair.*.path',
        'item.id',
        'item.token',
        'both.roleId',
        'tree.parentId',
        'raw',
      ].sort(),
    )
  })

  it('sees the module key of business.customize (item.id, inside a discriminated union) and classifies it', () => {
    const schema = inputSchemaOf('business.customize')
    expect(schema && referenceFields(schema)).toEqual(['item.id'])
    expect(Object.keys(PROBES['business.customize']?.notReferences ?? {})).toEqual(['item.id'])
  })

  it('says how the victim’s reference is refused for every input that names a row', () => {
    const withReferences: string[] = []
    for (const procedure of PROCEDURES) {
      const schema = inputSchemaOf(procedure.path)
      const found = schema ? referenceFields(schema) : []
      const probe = probeOf(procedure)
      // A classification must name a field the walk finds (no stale entries).
      for (const path of Object.keys(probe.notReferences ?? {})) {
        expect(found, `${procedure.path}: notReferences.${path}`).toContain(path)
      }
      const references = found.filter((path) => !probe.notReferences?.[path])
      if (references.length === 0) continue
      withReferences.push(procedure.path)
      if (procedure.base === 'business') {
        expect(
          probe.variants?.(STUB, STUB).some((v) => v.own),
          `${procedure.path} (${references.join(', ')}): add a variant with the answers in the attacker's own business`,
        ).toBe(true)
      } else {
        expect(
          probe.answer,
          `${procedure.path} (${references.join(', ')}): a victim's reference must be refused`,
        ).not.toBe('ok')
      }
    }
    // The walk finds references at all (ids, paths, tokens).
    expect(withReferences).toEqual(
      expect.arrayContaining([
        'account.setLastBusiness',
        'business.setLogo',
        'invitation.accept',
        'location.rename',
        'member.changeRole',
        'role.updatePermissions',
      ]),
    )
  })
})

let api: Api
const tenants = {} as Record<'A' | 'B', Tenant>

beforeAll(async () => {
  api = openApi()
  tenants.A = await createTenant(api, 'A')
  tenants.B = await createTenant(api, 'B')
}, 120_000)

afterAll(async () => {
  await api.close()
})

const DIRECTIONS = [
  ['A', 'B'],
  ['B', 'A'],
] as const

function members(tenant: Tenant): [string, Person][] {
  return [
    ['owner', tenant.owner],
    ['admin', tenant.admin],
    ['employee', tenant.employee],
  ]
}

describe('control: the leak check sees a business’s data', () => {
  it('finds the business’s markers in what its own owner reads', async () => {
    const tenant = tenants.B
    for (const path of ['business.profile', 'member.list', 'location.list', 'invitation.list']) {
      const result = await query(api.handler, path, {
        token: tenant.owner.token,
        businessId: tenant.id,
      })
      expect(result.error, path).toBeUndefined()
      expect(leaksOf(result.raw, tenant).length, path).toBeGreaterThan(0)
    }
    const me = await query(api.handler, 'me', { token: tenant.owner.token })
    expect(leaksOf(me.raw, tenant)).toEqual(
      expect.arrayContaining([tenant.id, tenant.legalName, tenant.legalNameAr, tenant.logoPath]),
    )
  })
})

describe.each(DIRECTIONS)('business %s attacks business %s', (attackerKey, victimKey) => {
  const attacker = () => tenants[attackerKey]
  const victim = () => tenants[victimKey]
  let victimBefore: Record<string, string>

  beforeAll(async () => {
    victimBefore = await tenantDigest(api.admin, victim())
  })

  it.each(BUSINESS.map((p) => [p.path, p] as const))(
    '%s with the victim’s x-business-id: FORBIDDEN for the owner, the Admin and the Employee',
    async (_path, procedure) => {
      const variants = probeOf(procedure).variants?.(victim(), attacker()) ?? [{ input: undefined }]
      for (const [role, person] of members(attacker())) {
        for (const { input } of variants) {
          const result = await callProcedure(api.handler, procedure, person.token, {
            businessId: victim().id,
            input,
          })
          const what = `${procedure.path} as ${role}`
          expect(result.status, what).toBe(403)
          expect(result.error?.data.appCode, what).toBe('forbidden')
          expect(result.headers.get('x-permissions-version'), what).toBeNull()
          expect(leaksOf(result.raw, victim(), input), what).toEqual([])
        }
      }
    },
  )

  it.each(OWN_BUSINESS.map((p) => [p.path, p] as const))(
    '%s in the attacker’s own business with the victim’s ids: refused',
    async (_path, procedure) => {
      for (const { input, own } of probeOf(procedure).variants?.(victim(), attacker()) ?? []) {
        if (!own) continue
        const result = await callProcedure(api.handler, procedure, attacker().owner.token, {
          businessId: attacker().id,
          input,
        })
        const what = `${procedure.path} ${JSON.stringify(input)}`
        expect(own, `${what}: ${result.raw}`).toContain(result.error?.data.appCode)
        expect(leaksOf(result.raw, victim(), input), what).toEqual([])
      }
    },
  )

  it.each(OUTSIDE.map((p) => [p.path, p] as const))(
    '%s (outside any business) serves the attacker nothing of the victim',
    async (_path, procedure) => {
      const probe = probeOf(procedure)
      const variants = probe.variants?.(victim(), attacker()) ?? [{ input: undefined }]
      for (const { input } of variants) {
        // x-business-id of the victim is ignored outside business procedures.
        const token = procedure.base === 'public' ? undefined : attacker().owner.token
        for (const businessId of [undefined, victim().id]) {
          const result = await callProcedure(api.handler, procedure, token, { businessId, input })
          const what = `${procedure.path} ${businessId ? 'with' : 'without'} x-business-id`
          if (probe.answer === 'ok') expect(result.error, `${what}: ${result.raw}`).toBeUndefined()
          else expect(probe.answer, `${what}: ${result.raw}`).toContain(result.error?.data.appCode)
          expect(leaksOf(result.raw, victim(), input), what).toEqual([])
        }
      }
    },
  )

  it('x-business-id spelled otherwise (capitals, spaces, two ids) opens nothing of the victim', async () => {
    const spellings = [
      victim().id.toUpperCase(),
      ` ${victim().id} `,
      `${attacker().id}, ${victim().id}`,
      `${victim().id},${attacker().id}`,
    ]
    for (const spelling of spellings) {
      for (const path of ['business.context', 'business.profile', 'member.list']) {
        const result = await query(api.handler, path, {
          token: attacker().owner.token,
          headers: { 'x-business-id': spelling },
        })
        expect(['forbidden', 'validation'], `${path} ${spelling}`).toContain(
          result.error?.data.appCode,
        )
        expect(leaksOf(result.raw, victim()), `${path} ${spelling}`).toEqual([])
      }
    }
  })

  it('leaves the victim exactly as it was: rows, audit log, profiles and Storage objects', async () => {
    const attackerIds = members(attacker()).map(([, person]) => person.user.id)
    const [audited] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where business_id = ${victim().id} and actor_user_id = any(${attackerIds}::uuid[])`
    expect(audited?.n).toBe(0)
    expect(await tenantDigest(api.admin, victim())).toEqual(victimBefore)
  })
})
