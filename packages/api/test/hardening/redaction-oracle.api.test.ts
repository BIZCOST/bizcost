import {
  isWithMeta,
  withMeta,
  type AttachmentUploadUrlDto,
  type BooksDto,
  type MaterialDto,
  type PurchaseDto,
  type PurchaseReturnDto,
  type SupplierDto,
} from '@bizcost/contracts'
import { newId, SENSITIVITY_CATEGORIES, type SensitivityCategory } from '@bizcost/domain'
import {
  ROLE_TEMPLATE_KEYS,
  roleTemplateByKey,
  type PermissionKey,
  type RoleTemplateKey,
} from '@bizcost/modules'
import type { AnyRouter } from '@trpc/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { appRouter, businessProcedure, router } from '../../src'
import { sensitivePaths, type SensitivePath } from '../../src/redact'
import { item, itemDto, VALUES_OF, VISIBLE_TO } from '../oracle'
import { join, setupBusiness, WORKSHOP } from '../settings'
import {
  callProcedure,
  openApi,
  PNG,
  proceduresOf,
  uploadTo,
  type Api,
  type Person,
} from './fixture'

// Redaction oracle over EVERY procedure whose output has sensitivity tags (ROADMAP.md Step 9; M1
// definition of done: "the Employee (staff) role template receives no field tagged sensitive"). The
// router is walked: each procedure with sensitive() fields in its output must have an entry in
// ORACLE, and is called by a member holding each of the 7 role templates as Smart Setup copied them
// into a real business. What each template may see is the hand-written VISIBLE_TO (test/oracle.ts):
// `meta.redacted` must list exactly the paths of the hidden categories, and the response must carry
// a category's values exactly when the template may see it. A template without the procedure's
// permission gets FORBIDDEN, with none of the values.
//
// M2 Step 3 brings the first production procedures with sensitive fields: the material cost view
// (average cost: `cost`; last purchase price: `supplier_price`), purchases, supplier returns and
// credit notes (what was paid to a supplier: `supplier_price`) and their receipts (the download URL:
// `supplier_price`). Their values are distinctive numbers of the fixture below. The test procedure
// `test.item` (a value in every category, nested in objects and arrays) stays. The first test fails
// the day a production procedure gets a sensitive field without an ORACLE entry, and the day an
// ORACLE entry no longer has one.

interface OracleEntry {
  /** The permission the procedure needs; templates without it get FORBIDDEN (none: every member). */
  permission?: PermissionKey
  /** Input of the call, or a function preparing a fresh one (as the owner) for each call. */
  input?: unknown
  prepare?: () => Promise<unknown>
  /** The values the call returns in each category (each must be in the answer when visible). */
  valuesOf: Partial<Record<SensitivityCategory, readonly string[]>>
}

// The fixture's numbers: two purchases of a material (3 L at 41.17, then 1 L at 52.39) and a credit
// note of 7.77 on the first, so its 90-day average is (123.51 − 7.77 + 52.39) ÷ 4 = 42.0325 a litre
// (`cost`; material.costs runs first, before the cases below post more) and its last price 52.39
// (`supplier_price`); credit notes of 7.77; receipts' signed URLs.
const UNIT_PRICE = '41.17'
const LINE_TOTAL = '123.51'
const LAST_PRICE = '52.39'
const AVERAGE = '42.0325'
const CREDIT = '7.77'
const SIGNED_URL = '/object/sign/'

let api: Api
let businessId: string
const members = new Map<RoleTemplateKey, Person>()
let material: MaterialDto
let supplier: SupplierDto
let purchase: PurchaseDto
let credit: PurchaseReturnDto
let today: string

/** Calls a procedure as the owner (fixture set-up). */
async function asOwner<T>(path: string, type: 'query' | 'mutation', input?: unknown): Promise<T> {
  const owner = members.get('owner')!
  const result = await callProcedure<T>(api.handler, { path, type }, owner.token, {
    businessId,
    input,
  })
  expect(result.error, `${path}: ${result.raw}`).toBeUndefined()
  return result.data as T
}

function draftInput() {
  return {
    id: newId(),
    supplierId: supplier.id,
    businessDate: today,
    documentType: 'no_invoice',
    lines: [
      {
        kind: 'material',
        id: newId(),
        materialId: material.id,
        qty: '3',
        unit: 'l',
        unitPrice: UNIT_PRICE,
      },
    ],
  }
}

async function newDraft(): Promise<PurchaseDto> {
  return (await asOwner<{ data: PurchaseDto }>('purchase.create', 'mutation', draftInput())).data
}

async function newPosted(): Promise<PurchaseDto> {
  const draft = await newDraft()
  return (
    await asOwner<{ data: PurchaseDto }>('purchase.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
}

function creditInput() {
  return {
    id: newId(),
    purchaseId: purchase.id,
    kind: 'credit_note',
    businessDate: today,
    lines: [{ id: newId(), purchaseLineId: purchase.lines[0]?.id, amount: CREDIT }],
  }
}

async function newCredit(): Promise<PurchaseReturnDto> {
  return (
    await asOwner<{ data: PurchaseReturnDto }>('purchaseReturn.create', 'mutation', creditInput())
  ).data
}

async function uploaded(): Promise<string> {
  const upload = await asOwner<AttachmentUploadUrlDto>('attachment.uploadUrl', 'mutation', {
    entity: 'purchase',
    entityId: purchase.id,
    contentType: 'image/png',
  })
  expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  return upload.path
}

const PRICE = { supplier_price: [UNIT_PRICE, LINE_TOTAL] }

/** Production procedures with sensitive output (M2 Step 3). */
const PRODUCTION_ORACLE: Record<string, OracleEntry> = {
  'material.costs': {
    permission: 'materials.items.view',
    prepare: () => Promise.resolve({ ids: [material.id] }),
    valuesOf: { cost: [AVERAGE], supplier_price: [LAST_PRICE] },
  },
  'purchase.list': {
    permission: 'purchases.documents.view',
    valuesOf: { supplier_price: [LINE_TOTAL] },
  },
  'purchase.get': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ id: purchase.id }),
    valuesOf: PRICE,
  },
  'purchase.create': {
    permission: 'purchases.documents.manage',
    prepare: () => Promise.resolve(draftInput()),
    valuesOf: PRICE,
  },
  'purchase.update': {
    permission: 'purchases.documents.manage',
    prepare: async () => {
      const draft = await newDraft()
      return { ...draftInput(), id: draft.id, version: draft.version }
    },
    valuesOf: PRICE,
  },
  'purchase.post': {
    permission: 'purchases.documents.post',
    prepare: async () => {
      const draft = await newDraft()
      return { id: draft.id, version: draft.version }
    },
    valuesOf: PRICE,
  },
  'purchase.reverse': {
    permission: 'purchases.documents.reverse',
    prepare: async () => ({ id: (await newPosted()).id }),
    valuesOf: PRICE,
  },
  'purchase.correct': {
    permission: 'purchases.documents.reverse',
    prepare: async () => ({ id: (await newPosted()).id, newId: newId() }),
    valuesOf: PRICE,
  },
  'purchaseReturn.list': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ purchaseId: purchase.id }),
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.get': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ id: credit.id }),
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.create': {
    permission: 'purchases.documents.manage',
    prepare: () => Promise.resolve(creditInput()),
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.update': {
    permission: 'purchases.documents.manage',
    prepare: async () => {
      const draft = await newCredit()
      const { lines, businessDate } = creditInput()
      return { id: draft.id, version: draft.version, businessDate, lines }
    },
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.post': {
    permission: 'purchases.documents.post',
    prepare: async () => {
      const draft = await newCredit()
      return { id: draft.id, version: draft.version }
    },
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.reverse': {
    permission: 'purchases.documents.reverse',
    prepare: async () => {
      const draft = await newCredit()
      await asOwner('purchaseReturn.post', 'mutation', { id: draft.id, version: draft.version })
      return { id: draft.id }
    },
    valuesOf: { supplier_price: [CREDIT] },
  },
  'attachment.list': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ entity: 'purchase', entityId: purchase.id }),
    valuesOf: { supplier_price: [SIGNED_URL] },
  },
  'attachment.add': {
    permission: 'purchases.documents.manage',
    prepare: async () => ({
      entity: 'purchase',
      entityId: purchase.id,
      path: await uploaded(),
      fileName: 'receipt.png',
    }),
    valuesOf: { supplier_price: [SIGNED_URL] },
  },
}

/** The Step 2 test procedure, served beside appRouter (never part of it). */
const TEST_ORACLE: Record<string, OracleEntry> = {
  'test.item': { valuesOf: VALUES_OF },
}

const oracleRouter = router({
  ...appRouter._def.record,
  test: router({
    item: businessProcedure
      .output(withMeta(itemDto))
      .query(() => ({ data: item, meta: { redacted: [] } })),
  }),
})

/** Sensitive paths of every procedure of `r` that has any (paths relative to the envelope's data). */
function sensitiveProcedures(r: AnyRouter): Map<string, readonly SensitivePath[]> {
  const found = new Map<string, readonly SensitivePath[]>()
  for (const [path, procedure] of Object.entries(
    r._def.procedures as Record<string, { _def: { output?: unknown } }>,
  )) {
    const output = procedure._def.output as z.core.$ZodType
    const data = isWithMeta(output) ? (output as z.ZodObject).shape.data : output
    const paths = sensitivePaths(data as z.core.$ZodType)
    if (paths.length > 0) found.set(path, paths)
  }
  return found
}

/** Whether a member of the template holds the permission (the owner holds every one). */
function holds(template: RoleTemplateKey, permission: PermissionKey | undefined): boolean {
  const t = roleTemplateByKey(template)
  if (!t) throw new Error(`no template ${template}`)
  return permission === undefined || t.allPermissions || t.permissionKeys.includes(permission)
}

describe('the oracle covers every procedure with sensitive output', () => {
  it('production: exactly the procedures in PRODUCTION_ORACLE have sensitive fields', () => {
    expect(
      [...sensitiveProcedures(appRouter).keys()].sort(),
      'a procedure outputs sensitive() fields: add it to PRODUCTION_ORACLE with its values',
    ).toEqual(Object.keys(PRODUCTION_ORACLE).sort())
  })

  it('the oracle router: every sensitive procedure has an entry, and every category a value', () => {
    const sensitive = sensitiveProcedures(oracleRouter)
    expect([...sensitive.keys()].sort()).toEqual(
      Object.keys({ ...PRODUCTION_ORACLE, ...TEST_ORACLE }).sort(),
    )
    // test.item holds every category, so every template's view is checked.
    expect(new Set(sensitive.get('test.item')?.map((p) => p.category))).toEqual(
      new Set(SENSITIVITY_CATEGORIES),
    )
    // Each entry names values for exactly the categories its procedure outputs.
    for (const [path, entry] of Object.entries(PRODUCTION_ORACLE)) {
      expect(Object.keys(entry.valuesOf).sort(), path).toEqual(
        [...new Set(sensitive.get(path)?.map((p) => p.category))].sort(),
      )
    }
  })
})

beforeAll(async () => {
  api = openApi(oracleRouter)
  const owner = await api.newPerson()
  businessId = await setupBusiness(api.handler, owner.token, WORKSHOP, { name: 'Oracle Workshop' })
  members.set('owner', owner)
  for (const template of ROLE_TEMPLATE_KEYS.filter((key) => key !== 'owner')) {
    const person = await api.newPerson()
    // The business's own template role, as Smart Setup copied it (an accepted invitation's way).
    await join(api.db, owner.user, businessId, person.user, template)
    members.set(template, person)
  }
  today = (await asOwner<BooksDto>('books.get', 'query')).today
  material = await asOwner<MaterialDto>('material.create', 'mutation', {
    id: newId(),
    name: 'Oracle milk',
    unit: 'l',
  })
  supplier = await asOwner<SupplierDto>('supplier.create', 'mutation', {
    id: newId(),
    name: 'Oracle dairy',
  })
  purchase = await newPosted()
  const second = (
    await asOwner<{ data: PurchaseDto }>('purchase.create', 'mutation', {
      ...draftInput(),
      lines: [
        {
          kind: 'material',
          id: newId(),
          materialId: material.id,
          qty: '1',
          unit: 'l',
          unitPrice: LAST_PRICE,
        },
      ],
    })
  ).data
  await asOwner('purchase.post', 'mutation', { id: second.id, version: second.version })
  const draft = await newCredit()
  credit = (
    await asOwner<{ data: PurchaseReturnDto }>('purchaseReturn.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
  await asOwner('attachment.add', 'mutation', {
    entity: 'purchase',
    entityId: purchase.id,
    path: await uploaded(),
    fileName: 'receipt.png',
  })
}, 90_000)

afterAll(async () => {
  await api.close()
})

const ORACLE = { ...PRODUCTION_ORACLE, ...TEST_ORACLE }
const CASES = Object.keys(ORACLE).flatMap((path) =>
  ROLE_TEMPLATE_KEYS.map((template) => [path, template] as const),
)

describe('each role template receives exactly the categories it may see', () => {
  it.each(CASES)('%s as %s', async (path, template) => {
    const entry = ORACLE[path]
    const person = members.get(template)
    const paths = sensitiveProcedures(oracleRouter).get(path) ?? []
    const procedure = proceduresOf(oracleRouter).find((p) => p.path === path)
    if (!entry || !person || !procedure) throw new Error(`no fixture for ${path} as ${template}`)
    const visible = new Set(VISIBLE_TO[template])
    const input = entry.prepare ? await entry.prepare() : entry.input

    const result = await callProcedure<{ meta: { redacted: string[] } }>(
      api.handler,
      procedure,
      person.token,
      { businessId, input },
    )
    const values = Object.values(entry.valuesOf).flat()
    if (!holds(template, entry.permission)) {
      // Not theirs to call: refused before anything is read, with nothing sensitive.
      expect(result.error?.data.appCode, result.raw).toBe('forbidden')
      for (const value of values) expect(result.raw.includes(value), value).toBe(false)
      return
    }
    expect(result.error, result.raw).toBeUndefined()
    const hidden = paths.filter((p) => !visible.has(p.category)).map((p) => p.path)
    expect(result.data?.meta.redacted).toEqual([...hidden].sort())
    for (const category of SENSITIVITY_CATEGORIES) {
      for (const value of entry.valuesOf[category] ?? []) {
        expect(result.raw.includes(value), `${category} ${value}`).toBe(visible.has(category))
      }
    }

    // The client is told the same categories (business.context), so it locks the same fields.
    const context = await callProcedure<{ visibleCategories: string[] }>(
      api.handler,
      { path: 'business.context', type: 'query' },
      person.token,
      { businessId },
    )
    expect(context.data?.visibleCategories).toEqual(VISIBLE_TO[template])
  })
})
