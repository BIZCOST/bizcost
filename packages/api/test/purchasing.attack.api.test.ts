import type {
  AttachmentDto,
  AttachmentListDto,
  AttachmentUploadUrlDto,
  PurchaseDto,
} from '@bizcost/contracts'
import { withTenantTx } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember, handlerFor, mutate, query, SECRET_KEY, tenant } from './helpers'
import {
  codeOf,
  line,
  milkInput,
  ok,
  purchaseInput,
  PurchasingApi,
  Scope,
  type Handler,
  type Person,
} from './purchasing'
import { WORKSHOP } from './settings'

// Attacks on purchasing (ROADMAP.md M2 Step 3; D-036, D-110): the ledger is append-only for the API
// role and for everyone else (trigger); a posted purchase and its lines never change; another
// business's materials, suppliers, locations, purchases and lines are refused in the attacker's own
// business; and receipts (attachments) go through the upload registry, are checked before they are
// attached, and their download URLs reach only members who may see supplier prices.

let api: PurchasingApi
let files: Handler
let a: Scope
let b: Scope
let today: string

beforeAll(async () => {
  api = new PurchasingApi()
  files = handlerFor(api.db, undefined, { supabaseSecretKey: SECRET_KEY })
  a = await Scope.open(api, WORKSHOP)
  b = await Scope.open(api, WORKSHOP)
  today = await a.today()
}, 60_000)

afterAll(async () => {
  await api.close()
})

/** Runs SQL as bizcost_api in the business, as the owner; the SQLSTATE of a refusal, or 'ok'. */
async function asApi(scope: Scope, statement: ReturnType<typeof sql>): Promise<string> {
  try {
    await withTenantTx(api.db, tenant(scope.owner.user.id, scope.id), (tx) => tx.execute(statement))
    return 'ok'
  } catch (error) {
    let current: unknown = error
    while (current && typeof current === 'object') {
      if (
        'code' in current &&
        typeof current.code === 'string' &&
        /^[0-9A-Z]{5}$/.test(current.code)
      ) {
        return current.code
      }
      current = 'cause' in current ? current.cause : undefined
    }
    throw error
  }
}

async function adminState(statement: string, ...params: string[]): Promise<string> {
  try {
    await api.admin.unsafe(statement, params)
    return 'ok'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}

describe('the ledger and posted documents never change', () => {
  let posted: PurchaseDto

  beforeAll(async () => {
    const milk = await a.material()
    posted = await a.buy(purchaseInput(today, [line(milk.id, '10', '6')]))
  })

  it('stock_movements: the API role may only read and add; nobody changes or deletes a row', async () => {
    expect(await asApi(a, sql`update app.stock_movements set value = 0`)).toBe('42501')
    expect(await asApi(a, sql`delete from app.stock_movements`)).toBe('42501')
    expect(
      await adminState(`update app.stock_movements set value = 0 where business_id = $1`, a.id),
    ).toBe('23001')
    expect(await adminState(`delete from app.stock_movements where business_id = $1`, a.id)).toBe(
      '23001',
    )
  })

  it('a posted purchase and its lines are never edited, deleted or added to', async () => {
    expect(
      await asApi(a, sql`update app.purchases set notes = 'changed' where id = ${posted.id}`),
    ).toBe('23001')
    expect(await asApi(a, sql`delete from app.purchases where id = ${posted.id}`)).toBe('23001')
    expect(
      await asApi(
        a,
        sql`update app.purchase_lines set unit_price = 1 where purchase_id = ${posted.id}`,
      ),
    ).toBe('23001')
    const lineRow = posted.lines[0]!
    expect(
      await asApi(
        a,
        sql`insert into app.purchase_lines (id, business_id, purchase_id, position, kind,
                                            material_id, qty, unit, unit_price)
            values (${newId()}, ${a.id}, ${posted.id}, 9, 'material', ${lineRow.materialId},
                    1, 'l', 1)`,
      ),
    ).toBe('23001')
    // Only the reversal columns may change, from posted to reversed.
    expect(
      await asApi(
        a,
        sql`update app.purchases set status = 'draft', posted_at = null, posted_by = null,
                   vat_in_cost = null, cost_total = null where id = ${posted.id}`,
      ),
    ).toBe('23001')
  })
})

describe('another business’s rows, used in the attacker’s own business', () => {
  let victim: {
    material: string
    pack: string
    supplier: string
    purchase: PurchaseDto
  }

  beforeAll(async () => {
    const { input, carton } = milkInput()
    const material = await b.material(input)
    const supplier = await b.supplier()
    const purchase = await b.buy(purchaseInput(today, [line(material.id, '5', '6')]))
    victim = { material: material.id, pack: carton, supplier: supplier.id, purchase }
  })

  it('purchases name only the business’s own materials, packs, suppliers and locations', async () => {
    const own = await a.material()
    const victimLocation = (
      await api.admin<{ id: string }[]>`
        select id from app.locations where business_id = ${b.id} and is_default`
    )[0]!.id
    const cases: [object, string][] = [
      [purchaseInput(today, [line(victim.material, '1', '1')]), 'not_found'],
      [
        purchaseInput(today, [line(own.id, '1', '1')], { supplierId: victim.supplier }),
        'not_found',
      ],
      [purchaseInput(today, [line(own.id, '1', '1')], { locationId: victimLocation }), 'not_found'],
      [
        purchaseInput(today, [
          {
            kind: 'material',
            id: newId(),
            materialId: own.id,
            qty: '1',
            packId: victim.pack,
            unitPrice: '1',
          },
        ]),
        'validation',
      ],
      // A line id of the victim's purchase is taken: CONFLICT, never a move.
      [
        purchaseInput(today, [{ ...line(own.id, '1', '1'), id: victim.purchase.lines[0]!.id }]),
        'conflict',
      ],
    ]
    for (const [input, code] of cases) {
      expect(codeOf(await a.run('purchase.create', input)), JSON.stringify(input)).toBe(code)
    }
  })

  it('returns, credit notes, costs and attachments of another business are NOT_FOUND', async () => {
    const own = await a.material()
    const mine = await a.buy(purchaseInput(today, [line(own.id, '5', '6')]))
    const lineOf = (p: PurchaseDto) => p.lines[0]!.id
    for (const [input, code] of [
      [
        {
          id: newId(),
          purchaseId: victim.purchase.id,
          kind: 'return',
          businessDate: today,
          lines: [{ id: newId(), purchaseLineId: lineOf(victim.purchase), qty: '1' }],
        },
        'not_found',
      ],
      [
        {
          id: newId(),
          purchaseId: mine.id,
          kind: 'credit_note',
          businessDate: today,
          lines: [{ id: newId(), purchaseLineId: lineOf(victim.purchase), amount: '1' }],
        },
        'not_found',
      ],
    ] as const) {
      expect(codeOf(await a.run('purchaseReturn.create', input))).toBe(code)
    }
    expect(codeOf(await a.run('material.costs', { ids: [own.id, victim.material] }))).toBe(
      'not_found',
    )
    expect(
      codeOf(
        await mutate(files, 'attachment.uploadUrl', {
          token: a.owner.token,
          businessId: a.id,
          input: { entity: 'purchase', entityId: victim.purchase.id, contentType: 'image/png' },
        }),
      ),
    ).toBe('not_found')
    // Nothing of the victim changed.
    expect(await b.costRow(victim.material)).toMatchObject({ qty: '5000', value: '30' })
  })
})

/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

async function put(url: string, bytes: Buffer, contentType: string) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'x-upsert': 'false' },
    body: new Uint8Array(bytes),
  })
  await response.arrayBuffer()
  return response
}

describe('receipts (attachments)', () => {
  let purchase: PurchaseDto
  let manager: Person
  let blind: Person

  beforeAll(async () => {
    const milk = await a.material()
    purchase = await a.buy(purchaseInput(today, [line(milk.id, '1', '9')]))
    manager = await api.member({ id: a.id, owner: a.owner }, 'manager')
    // A manager who may not see supplier prices (a deny override).
    blind = await api.person()
    await addMember(api.db, a.owner.user, a.id, blind.user, {
      template: 'manager',
      overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
    })
  })

  const call = <T>(person: Person, path: string, input: object) => {
    const run = path === 'attachment.list' ? query<T> : mutate<T>
    return run(files, path, { token: person.token, businessId: a.id, input })
  }

  async function attach(
    person: Person,
    bytes: Buffer,
    contentType: string,
    fileName: string,
    entityId = purchase.id,
  ) {
    const url = ok(
      await call<AttachmentUploadUrlDto>(person, 'attachment.uploadUrl', {
        entity: 'purchase',
        entityId,
        contentType,
      }),
    )
    expect(url.path.startsWith(`${a.id}/purchase/`)).toBe(true)
    expect((await put(url.uploadUrl, bytes, contentType)).ok).toBe(true)
    return {
      url,
      result: await call<{ data: AttachmentDto }>(person, 'attachment.add', {
        entity: 'purchase',
        entityId,
        path: url.path,
        fileName,
      }),
    }
  }

  it('a photo and a PDF: uploaded, checked, attached, listed with short-lived links, removed', async () => {
    const photo = await attach(manager, PNG, 'image/png', 'receipt.png')
    expect(ok(photo.result).data).toMatchObject({
      fileName: 'receipt.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
    })
    const pdf = ok((await attach(manager, PDF, 'application/pdf', 'فاتورة.pdf')).result).data
    const list = ok(
      await call<AttachmentListDto>(manager, 'attachment.list', {
        entity: 'purchase',
        entityId: purchase.id,
      }),
    )
    expect(list.meta.redacted).toEqual([])
    expect(list.data.items.map((f) => f.fileName)).toEqual(['receipt.png', 'فاتورة.pdf'])
    const download = await fetch(list.data.items[1]!.url!)
    expect(Buffer.from(await download.arrayBuffer()).toString()).toBe(PDF.toString())
    expect(
      ok(await a.run<{ data: PurchaseDto }>('purchase.get', { id: purchase.id })).data
        .attachmentCount,
    ).toBe(2)

    // Attached once: the same path again is refused.
    expect(
      codeOf(
        await call(manager, 'attachment.add', {
          entity: 'purchase',
          entityId: purchase.id,
          path: photo.url.path,
          fileName: 'again.png',
        }),
      ),
    ).toBe('attachment_invalid')

    ok(await call(manager, 'attachment.remove', { id: pdf.id }))
    const [object] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from storage.objects o
       where o.bucket_id = 'business-files'
         and o.name = (select a.path from app.attachments a where a.id = ${pdf.id})`
    expect(object?.n).toBe(0)
    const after = ok(
      await call<AttachmentListDto>(manager, 'attachment.list', {
        entity: 'purchase',
        entityId: purchase.id,
      }),
    )
    expect(after.data.items.map((f) => f.fileName)).toEqual(['receipt.png'])
  })

  it('a discarded draft takes its receipts with it: rows taken off, files removed', async () => {
    const milk = await a.material()
    const draft = await a.draft(purchaseInput(today, [line(milk.id, '1', '2')]))
    const file = ok((await attach(manager, PNG, 'image/png', 'draft.png', draft.id)).result).data
    const [path] = await api.admin<{ path: string }[]>`
      select path from app.attachments where id = ${file.id}`
    ok(
      await mutate(files, 'purchase.discard', {
        token: manager.token,
        businessId: a.id,
        input: { id: draft.id, version: draft.version },
      }),
    )
    const [row] = await api.admin<{ deleted: boolean; status: string }[]>`
      select a.deleted_at is not null as deleted, u.status
        from app.attachments a
        join app.file_uploads u on u.business_id = a.business_id and u.path = a.path
       where a.id = ${file.id}`
    expect(row).toEqual({ deleted: true, status: 'discarded' })
    const [object] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from storage.objects
       where bucket_id = 'business-files' and name = ${path!.path}`
    expect(object?.n).toBe(0)
  })

  it('refuses what is not the file it says, and paths it did not issue here', async () => {
    const fake = await attach(manager, Buffer.from('not a pdf at all'), 'application/pdf', 'x.pdf')
    expect(codeOf(fake.result)).toBe('attachment_invalid')
    const [left] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from storage.objects
       where bucket_id = 'business-files' and name = ${fake.url.path}`
    expect(left?.n).toBe(0)
    for (const path of [
      `${b.id}/purchase/${newId()}.png`,
      `${a.id}/logo/${newId()}.png`,
      `${a.id}/purchase/../logo/${newId()}.png`,
    ]) {
      expect(
        codeOf(
          await call(manager, 'attachment.add', {
            entity: 'purchase',
            entityId: purchase.id,
            path,
            fileName: 'x.png',
          }),
        ),
        path,
      ).toBe('validation')
    }
    // A logo upload is not an attachment.
    const logo = ok(
      await mutate<{ path: string }>(files, 'business.logoUploadUrl', {
        token: a.owner.token,
        businessId: a.id,
        input: { contentType: 'image/png' },
      }),
    )
    expect(
      codeOf(
        await call(manager, 'attachment.add', {
          entity: 'purchase',
          entityId: purchase.id,
          path: logo.path,
          fileName: 'x.png',
        }),
      ),
    ).toBe('validation')
  })

  it('a member who may not see supplier prices sees the file’s name, not the file', async () => {
    await attach(manager, PNG, 'image/png', 'shown.png')
    const list = ok(
      await call<AttachmentListDto>(blind, 'attachment.list', {
        entity: 'purchase',
        entityId: purchase.id,
      }),
    )
    expect(list.meta.redacted).toEqual(['items.*.url'])
    expect(list.data.items.length).toBeGreaterThan(0)
    for (const item of list.data.items) {
      expect(item.fileName).toBeTruthy()
      expect('url' in item).toBe(false)
    }
    // And the purchase itself without its prices.
    const got = ok(
      await api.call<{ data: PurchaseDto; meta: { redacted: string[] } }>(
        blind,
        a.id,
        'purchase.get',
        { id: purchase.id },
      ),
    )
    expect(got.meta.redacted).toContain('total')
    expect(got.data.total).toBeUndefined()
    expect(got.data.lines[0]?.qty).toBe('1')
  })
})
