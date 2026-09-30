import type {
  AttachmentDto,
  AttachmentUploadUrlDto,
  MaterialDto,
  PurchaseDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  connectAdmin,
  connectApi,
  handlerFor,
  mutate,
  SECRET_KEY,
  type Admin,
  type CallResult,
} from '../helpers'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope, type Handler } from '../purchasing'
import { WORKSHOP } from '../settings'

// Security review of M2 Step 3 (attacker A: tenancy, permissions, integrity). Two checks that are made
// in one statement and acted on in another, with nothing locked in between, so a concurrent request of
// the same business slips through. Each API instance below has its own database connection (like
// separate serverless functions). To make the interleaving deterministic, a separate postgres
// connection holds one row lock and releases it once the concurrent request is done: that only
// lengthens the window the service already leaves open between its check and its write.
//
//   1. attachment.add checks the purchase in one transaction and attaches in another, without locking
//      the purchase; purchase.discard takes the receipts it can see. A receipt attached while its draft
//      is discarded stays live on the discarded draft, its upload closed as "used", so its file is never
//      removed (D-139: "discarding a draft purchase takes its receipts with it"). The trigger
//      check_target does not refuse a discarded purchase either.
//   2. material.update checks "no purchase lines" (MATERIAL_IN_USE, D-134) before it takes the row lock,
//      and a draft's lines (FK: FOR KEY SHARE) and a posting (FOR SHARE) never conflict with that check.
//      A material can change its kind of measure after its goods came into the ledger: the ledger and
//      the cost row stay in millilitres while the material is now counted in grams.

let api: PurchasingApi
let dbs: Db[]
let handlers: Handler[]
let holder: Admin
let shop: Scope
let today: string

beforeAll(async () => {
  api = new PurchasingApi()
  dbs = [connectApi(), connectApi()]
  handlers = dbs.map((db) => handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY }))
  holder = connectAdmin()
  shop = await Scope.open(api, WORKSHOP)
  today = await shop.today()
}, 60_000)

afterAll(async () => {
  await holder.end()
  for (const db of dbs) await db.$client.end()
  await api.close()
})

/** Calls a mutation as the shop's owner on API instance `i`. */
function on<T>(i: number, path: string, input: object): Promise<CallResult<T>> {
  return mutate<T>(handlers[i]!, path, { token: shop.owner.token, businessId: shop.id, input })
}

/**
 * Holds `statement` (a row lock) in a transaction of its own connection until `release()`; resolves
 * once the lock is taken.
 */
async function hold(statement: (sql: Admin) => Promise<unknown>) {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let taken!: () => void
  const lockTaken = new Promise<void>((resolve) => {
    taken = resolve
  })
  const done = holder.begin(async (sql) => {
    await statement(sql as unknown as Admin)
    taken()
    await released
  })
  await lockTaken
  return {
    release: async () => {
      release()
      await done
    },
  }
}

/** Waits until a backend is blocked on a lock while running a statement like `pattern`. */
async function waitForLockWait(pattern: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const [row] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike ${pattern}`
    if ((row?.n ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`nothing waited on a lock for ${pattern}`)
}

/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

describe('a receipt attached while its draft is discarded (D-139)', () => {
  it('does not stay live on the discarded draft with its file kept forever', async () => {
    const milk = await shop.material()
    const draft = await shop.draft(purchaseInput(today, [line(milk.id, '1', '2')]))
    const target = ok(
      await on<AttachmentUploadUrlDto>(0, 'attachment.uploadUrl', {
        entity: 'purchase',
        entityId: draft.id,
        contentType: 'image/png',
      }),
    )
    const upload = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-upsert': 'false' },
      body: new Uint8Array(PNG),
    })
    await upload.arrayBuffer()
    expect(upload.ok).toBe(true)

    // attachment.add: its first transaction finds the draft live; its second attaches, then closes the
    // upload (held here), and only then commits.
    const lock = await hold(
      (sql) => sql`select 1 from app.file_uploads
                    where business_id = ${shop.id} and path = ${target.path} for update`,
    )
    const adding = on<{ data: AttachmentDto }>(0, 'attachment.add', {
      entity: 'purchase',
      entityId: draft.id,
      path: target.path,
      fileName: 'receipt.png',
    })
    await waitForLockWait('%update "app"."file_uploads"%')
    // Meanwhile the draft is discarded "with its receipts" on another instance.
    const discarded = await on(1, 'purchase.discard', { id: draft.id, version: draft.version })
    await lock.release()
    const added = await adding
    expect(discarded.error, discarded.raw).toBeUndefined()

    const [live] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.attachments
       where business_id = ${shop.id} and entity = 'purchase' and entity_id = ${draft.id}
         and deleted_at is null`
    const [registered] = await api.admin<{ status: string }[]>`
      select status from app.file_uploads where business_id = ${shop.id} and path = ${target.path}`
    const [object] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from storage.objects
       where bucket_id = 'business-files' and name = ${target.path}`
    // Secure outcomes: the attach is refused (NOT_FOUND), or the discard takes the receipt with it.
    // Either way no live receipt names the discarded draft, and a file that stays is still an open
    // upload that the clean-up of expired uploads removes; a closed ("used") one is never removed.
    expect({
      add: codeOf(added) ?? 'ok',
      liveReceiptsOnDiscardedDraft: live?.n,
      fileKeptWithClosedUpload: (object?.n ?? 0) > 0 && registered?.status === 'used',
    }).toEqual({
      add: 'not_found',
      liveReceiptsOnDiscardedDraft: 0,
      fileKeptWithClosedUpload: false,
    })
  })
})

describe('a material keeps its kind of measure once it is bought (MATERIAL_IN_USE, D-134)', () => {
  it('a purchase drafted and posted while a change of dimension is in flight is not left in the other dimension', async () => {
    const milk: MaterialDto = await shop.material()
    expect(milk.dimension).toBe('volume')

    // material.update (litres → kilograms): its "any purchase lines?" check runs first and finds none;
    // its UPDATE then waits for the row (a share lock held here).
    const lock = await hold(
      (sql) => sql`select 1 from app.materials where id = ${milk.id} for share`,
    )
    const changing = on<MaterialDto>(0, 'material.update', {
      id: milk.id,
      version: milk.version,
      name: milk.name,
      unit: 'kg',
      packs: [],
    })
    await waitForLockWait('%update "app"."materials"%')

    // Another member buys 10 L of it and finalizes the purchase: the draft's lines (FOR KEY SHARE) and
    // the posting (FOR SHARE on the material) never wait for the pending update.
    const draft = ok(
      await on<{ data: PurchaseDto }>(
        1,
        'purchase.create',
        purchaseInput(today, [line(milk.id, '10', '6')]),
      ),
    ).data
    const posted = ok(
      await on<{ data: PurchaseDto }>(1, 'purchase.post', { id: draft.id, version: draft.version }),
    ).data
    expect(posted.status).toBe('posted')
    expect(posted.lines[0]?.baseQty).toBe('10000') // millilitres

    await lock.release()
    const changed = await changing

    const [material] = await api.admin<{ dimension: string; unit: string }[]>`
      select dimension, unit from app.materials where id = ${milk.id}`
    const [ledger] = await api.admin<{ n: number; qty: string }[]>`
      select count(*)::int as n, trim_scale(sum(qty))::text as qty
        from app.stock_movements where material_id = ${milk.id}`
    expect(ledger).toEqual({ n: 1, qty: '10000' })
    // The ledger holds 10 000 base units of a volume (ml). The change must be refused, as it is when
    // the purchase was saved first; otherwise the same 10 000 now read as grams.
    expect({ update: codeOf(changed) ?? 'ok', dimension: material?.dimension }).toEqual({
      update: 'material_in_use',
      dimension: 'volume',
    })
  })

  // Fix review (D-145): the check of drafts runs under the material's row lock, and a draft save locks
  // the material FOR SHARE before it reads its units. Both orders of a draft and a change of dimension.
  it('a draft saved while a change of dimension waits for the row makes the change refused', async () => {
    const milk: MaterialDto = await shop.material()
    const lock = await hold(
      (sql) => sql`select 1 from app.materials where id = ${milk.id} for share`,
    )
    const changing = on<MaterialDto>(0, 'material.update', {
      id: milk.id,
      version: milk.version,
      name: milk.name,
      unit: 'kg',
      packs: [],
    })
    await waitForLockWait('%update "app"."materials"%')
    const draft = ok(
      await on<{ data: PurchaseDto }>(
        1,
        'purchase.create',
        purchaseInput(today, [line(milk.id, '10', '6')]),
      ),
    ).data
    await lock.release()
    const changed = await changing

    const [material] = await api.admin<{ dimension: string }[]>`
      select dimension from app.materials where id = ${milk.id}`
    const [lines] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.purchase_lines
       where purchase_id = ${draft.id} and material_id = ${milk.id} and unit = 'l'
         and deleted_at is null`
    expect({
      update: codeOf(changed) ?? 'ok',
      dimension: material?.dimension,
      draftLinesInLitres: lines?.n,
    }).toEqual({ update: 'material_in_use', dimension: 'volume', draftLinesInLitres: 1 })
  })

  it('a draft saved while a change of dimension holds the row waits for it and reads the new kind', async () => {
    const milk: MaterialDto = await shop.material()
    // material.update locks the material, finds no purchase, then waits here to take its packs out.
    const lock = await hold(
      (sql) => sql`select 1 from app.material_units where material_id = ${milk.id} for update`,
    )
    const changing = on<MaterialDto>(0, 'material.update', {
      id: milk.id,
      version: milk.version,
      name: milk.name,
      unit: 'kg',
      packs: [],
    })
    await waitForLockWait('%update "app"."material_units"%')
    const drafting = on<{ data: PurchaseDto }>(
      1,
      'purchase.create',
      purchaseInput(today, [line(milk.id, '10', '6')]),
    )
    await waitForLockWait('%from app.materials m%for share%')
    await lock.release()
    const [changed, drafted] = await Promise.all([changing, drafting])

    const [material] = await api.admin<{ dimension: string }[]>`
      select dimension from app.materials where id = ${milk.id}`
    const [lines] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.purchase_lines
       where material_id = ${milk.id} and deleted_at is null`
    expect({
      update: codeOf(changed) ?? 'ok',
      draft: codeOf(drafted) ?? 'ok',
      dimension: material?.dimension,
      lines: lines?.n,
    }).toEqual({ update: 'ok', draft: 'validation', dimension: 'mass', lines: 0 })
  })
})
