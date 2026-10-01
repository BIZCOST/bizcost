import type {
  AttachmentUploadUrlDto,
  BusinessProfileDto,
  LogoUploadUrlDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mutate, query, SUPABASE_URL, signIn, type Session } from '../helpers'
import {
  createTenant,
  openApi,
  PNG,
  tenantDigest,
  uploadTo,
  type Api,
  type Tenant,
} from './fixture'

// Clients reach Supabase only through the API (ROADMAP.md Step 9; ARCHITECTURE.md §Tenancy & security):
// with a REAL access token of a business owner (a password sign-in on the local Auth server, ES256)
// and with the publishable key alone, straight to the Data API (PostgREST) and Storage:
//   - /rest/v1 on every table, view and function of schema app (by name, and asking for schema app
//     and the other internal schemas): not found or refused, never a row; the OpenAPI root names none
//     of them; nothing in the exposed schemas public/graphql_public serves data;
//   - Storage, bucket business-files, on every kind of object it holds (logos, and the receipts of
//     purchases and expenses since M2): list, read, sign, upload (also at a path the API registered
//     as an open upload, which the Storage guard would let through), overwrite, delete, move, copy
//     and bucket changes, in the caller's own business and in another: all refused, and both
//     businesses' objects and rows are unchanged;
//   - signed URLs the API issued for business A (a logo's and a receipt's, to download and to
//     upload) cannot be re-pointed at business B (or at another object of A), nor used with a
//     tampered token.
// The tables, views and functions are read from the catalog, so every M2 table is attacked too.
// This file makes the run's one extra password sign-in (the local limit is 30 per 5 minutes per IP).

const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? ''
const REST = `${SUPABASE_URL}/rest/v1`
const STORAGE = `${SUPABASE_URL}/storage/v1`
const BUCKET = 'business-files'

let api: Api
let A: Tenant
let B: Tenant
let session: Session

beforeAll(async () => {
  api = openApi()
  A = await createTenant(api, 'A')
  B = await createTenant(api, 'B')
  session = await signIn(A.owner.user)
}, 120_000)

afterAll(async () => {
  await api.close()
})

type Identity = 'owner JWT' | 'publishable key only'
const IDENTITIES: Identity[] = ['owner JWT', 'publishable key only']

function headers(who: Identity, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: PUBLISHABLE_KEY,
    ...(who === 'owner JWT' ? { authorization: `Bearer ${session.access_token}` } : {}),
    ...extra,
  }
}

interface Answer {
  status: number
  text: string
  json: unknown
}

async function send(url: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

const refused = (answer: Answer) => answer.status >= 400
const rows = (answer: Answer) => (Array.isArray(answer.json) ? answer.json.length : 0)

// ---------------------------------------------------------------------------------------------------
// PostgREST
// ---------------------------------------------------------------------------------------------------

describe('the Data API (PostgREST) with a real user token', () => {
  let relations: string[]
  let functions: string[]
  let exposedRelations: string[]

  beforeAll(async () => {
    relations = (
      await api.admin<{ name: string }[]>`
        select relname::text as name from pg_class
         where relnamespace = 'app'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'f')
         order by 1`
    ).map((r) => r.name)
    functions = (
      await api.admin<{ name: string }[]>`
        select distinct proname::text as name from pg_proc
         where pronamespace = 'app'::regnamespace order by 1`
    ).map((r) => r.name)
    exposedRelations = (
      await api.admin<{ name: string }[]>`
        select nspname || '.' || relname as name from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where nspname in ('public', 'graphql_public') and relkind in ('r', 'p', 'v', 'm', 'f')
         order by 1`
    ).map((r) => r.name)
  })

  it('the token is a real ES256 session token, and PostgREST verifies it', async () => {
    const header = JSON.parse(
      Buffer.from(session.access_token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { alg: string; kid?: string }
    expect(header.alg).toBe('ES256')
    expect(header.kid).toBeTruthy()
    const root = await send(`${REST}/`, { headers: headers('owner JWT') })
    expect(
      root.status,
      `PostgREST must answer /rest/v1/ (start the stack with it: ci.yml's supabase start -x list must not name postgrest): ${root.text.slice(0, 200)}`,
    ).toBe(200)
    // A token with a broken signature is refused: the token above is really checked.
    const broken = `${session.access_token.slice(0, -4)}AAAA`
    const answer = await send(`${REST}/`, {
      headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${broken}` },
    })
    expect(answer.status).toBe(401)
  })

  it('finds the app tables to attack', () => {
    expect(relations).toEqual(
      expect.arrayContaining(['audit_log', 'business_members', 'businesses', 'profiles', 'roles']),
    )
    expect(functions).toEqual(expect.arrayContaining(['accept_invitation', 'create_business']))
  })

  it.each(IDENTITIES)(
    'no app table or view is reachable, by name or as schema app (%s)',
    async (who) => {
      for (const name of relations) {
        const plain = await send(`${REST}/${name}?select=*`, { headers: headers(who) })
        expect([401, 403, 404], `${name}: ${plain.text}`).toContain(plain.status)
        expect(rows(plain), name).toBe(0)
        const asApp = await send(`${REST}/${name}?select=*`, {
          headers: headers(who, { 'accept-profile': 'app' }),
        })
        expect(asApp.status, `${name}: ${asApp.text}`).toBe(406)
        expect(rows(asApp), name).toBe(0)
        for (const method of ['POST', 'PATCH', 'DELETE']) {
          const write = await send(`${REST}/${name}${method === 'POST' ? '' : '?id=not.is.null'}`, {
            method,
            headers: headers(who, {
              'content-profile': 'app',
              'content-type': 'application/json',
              prefer: 'return=representation',
            }),
            body: method === 'DELETE' ? undefined : JSON.stringify({ legal_name: 'Pwned' }),
          })
          expect(write.status, `${method} ${name}: ${write.text}`).toBe(406)
        }
      }
    },
  )

  it.each(IDENTITIES)('no app function is callable through /rpc (%s)', async (who) => {
    for (const name of functions) {
      for (const profile of [undefined, 'app']) {
        const answer = await send(`${REST}/rpc/${name}`, {
          method: 'POST',
          headers: headers(who, {
            'content-type': 'application/json',
            ...(profile ? { 'content-profile': profile } : {}),
          }),
          body: '{}',
        })
        expect(profile ? [406] : [401, 403, 404], `${name}: ${answer.text}`).toContain(
          answer.status,
        )
      }
      const get = await send(`${REST}/rpc/${name}`, { headers: headers(who) })
      expect([401, 403, 404], `GET ${name}: ${get.text}`).toContain(get.status)
    }
  })

  it.each(IDENTITIES)('the internal schemas are not exposed (%s)', async (who) => {
    const probes: [string, string][] = [
      ['auth', 'users'],
      ['storage', 'objects'],
      ['storage', 'buckets'],
      ['extensions', 'pg_stat_statements'],
      ['vault', 'secrets'],
      ['supabase_migrations', 'schema_migrations'],
      ['pg_catalog', 'pg_roles'],
      ['information_schema', 'tables'],
    ]
    for (const [schema, table] of probes) {
      const answer = await send(`${REST}/${table}?select=*`, {
        headers: headers(who, { 'accept-profile': schema }),
      })
      expect(answer.status, `${schema}.${table}: ${answer.text}`).toBe(406)
    }
  })

  it.each(IDENTITIES)('the OpenAPI root names no app table or function (%s)', async (who) => {
    const answer = await send(`${REST}/`, { headers: headers(who) })
    const described = answer.json as { paths?: Record<string, unknown> } | undefined
    const paths = Object.keys(described?.paths ?? {})
    for (const name of [...relations, ...functions]) {
      expect(paths, name).not.toContain(`/${name}`)
      expect(paths, name).not.toContain(`/rpc/${name}`)
    }
    for (const marker of [A.legalName, B.legalName, A.id, B.id]) {
      expect(answer.text).not.toContain(marker)
    }
  })

  it.each(IDENTITIES)('the exposed schemas serve no data (%s)', async (who) => {
    // Today public and graphql_public hold no table or view (a new one must stay empty here).
    for (const qualified of exposedRelations) {
      const [schema = '', name = ''] = qualified.split('.')
      const answer = await send(`${REST}/${name}?select=*`, {
        headers: headers(who, { 'accept-profile': schema }),
      })
      expect(rows(answer), qualified).toBe(0)
    }
    // GraphQL (pg_graphql is not installed): nothing about app.
    for (const url of [`${SUPABASE_URL}/graphql/v1`, `${REST}/rpc/graphql`]) {
      const answer = await send(url, {
        method: 'POST',
        headers: headers(who, {
          'content-type': 'application/json',
          'content-profile': 'graphql_public',
        }),
        body: JSON.stringify({
          query: '{ __schema { types { name } } businessesCollection { edges { node { id } } } }',
        }),
      })
      for (const marker of ['businesses', 'business_members', A.id, B.id]) {
        expect(answer.text, `${url} ${marker}`).not.toContain(marker)
      }
    }
  })
})

describe('the Auth admin API with a real user token', () => {
  it('lists, reads and deletes no user', async () => {
    const who = headers('owner JWT')
    for (const [method, url] of [
      ['GET', `${SUPABASE_URL}/auth/v1/admin/users`],
      ['GET', `${SUPABASE_URL}/auth/v1/admin/users/${B.owner.user.id}`],
      ['PUT', `${SUPABASE_URL}/auth/v1/admin/users/${B.owner.user.id}`],
      ['DELETE', `${SUPABASE_URL}/auth/v1/admin/users/${B.owner.user.id}`],
    ] as const) {
      const answer = await send(url, {
        method,
        headers: { ...who, 'content-type': 'application/json' },
        body:
          method === 'PUT'
            ? JSON.stringify({ email: `x-${newId()}@test.bizcost.local` })
            : undefined,
      })
      expect([401, 403], `${method} ${url}: ${answer.text}`).toContain(answer.status)
      expect(answer.text).not.toContain(B.owner.user.email)
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------
//
// Each business has objects of every kind the bucket holds: its logo and its receipts (a purchase's
// and an expense's, M2 Steps 3 and 5), and two uploads the API issued and nobody used (a logo's and a
// receipt's: the Storage guard would let Storage write there).

interface Objects {
  logo: string
  purchaseReceipt: string
  expenseReceipt: string
}

const objectsOf = new Map<Tenant, Objects>()
const openUploadsOf = new Map<Tenant, string[]>()

const pathsOf = (t: Tenant) => Object.values(objectsOf.get(t) ?? {}) as string[]
const fileOf = (path: string) => path.split('/').at(-1) ?? path

beforeAll(async () => {
  for (const t of [A, B]) {
    const rows = await api.admin<{ id: string; path: string }[]>`
      select id, path from app.attachments
       where business_id = ${t.id} and id in (${t.attachment.id}, ${t.expenseAttachment.id})`
    const pathOf = (id: string) => rows.find((r) => r.id === id)?.path ?? ''
    objectsOf.set(t, {
      logo: t.logoPath,
      purchaseReceipt: pathOf(t.attachment.id),
      expenseReceipt: pathOf(t.expenseAttachment.id),
    })
    const receipt = await mutate<AttachmentUploadUrlDto>(api.handler, 'attachment.uploadUrl', {
      token: t.owner.token,
      businessId: t.id,
      input: { entity: 'purchase', entityId: t.purchase.id, contentType: 'image/png' },
    })
    expect(receipt.error, receipt.raw).toBeUndefined()
    openUploadsOf.set(t, [t.openUpload.path, receipt.data!.path])
  }
})

async function objectEtag(path: string): Promise<string | undefined> {
  const [row] = await api.admin<{ etag: string }[]>`
    select coalesce(metadata ->> 'eTag', '') || ':' || coalesce(updated_at::text, '') as etag
      from storage.objects where bucket_id = ${BUCKET} and name = ${path}`
  return row?.etag
}

async function objectsUnder(businessId: string): Promise<string[]> {
  return (
    await api.admin<{ name: string }[]>`
      select name from storage.objects
       where bucket_id = ${BUCKET} and name like ${`${businessId}/%`} order by name`
  ).map((r) => r.name)
}

function png(who: Identity, extra: Record<string, string> = {}) {
  return { headers: headers(who, { 'content-type': 'image/png', ...extra }), body: PNG }
}

/** New paths of every kind in a business (never issued). */
const freshPaths = (t: Tenant) =>
  ['logo', 'purchase', 'expense'].map((kind) => `${t.id}/${kind}/${newId()}.png`)

describe('Storage straight from the client, with a real user token', () => {
  const targets = () =>
    [
      ['own business', A],
      ['another business', B],
    ] as const
  let digests: Record<string, Record<string, string>>

  beforeAll(async () => {
    digests = { A: await tenantDigest(api.admin, A), B: await tenantDigest(api.admin, B) }
  })

  it('every kind of object is there to attack: a logo and two receipts in each business', async () => {
    for (const t of [A, B]) {
      const objects = objectsOf.get(t)!
      expect(objects.purchaseReceipt).toMatch(new RegExp(`^${t.id}/purchase/`))
      expect(objects.expenseReceipt).toMatch(new RegExp(`^${t.id}/expense/`))
      for (const path of pathsOf(t)) expect(await objectEtag(path), path).toBeDefined()
      for (const path of openUploadsOf.get(t)!) expect(await objectEtag(path), path).toBeUndefined()
    }
  })

  it.each(IDENTITIES)('lists nothing and reads nothing (%s)', async (who) => {
    for (const [what, target] of targets()) {
      const prefixes = ['', `${target.id}/`]
      for (const kind of ['logo', 'purchase', 'expense']) {
        prefixes.push(`${target.id}/${kind}/`, `${target.id}/${kind}`)
      }
      for (const prefix of prefixes) {
        const listed = await send(`${STORAGE}/object/list/${BUCKET}`, {
          method: 'POST',
          headers: headers(who, { 'content-type': 'application/json' }),
          body: JSON.stringify({ prefix, limit: 100 }),
        })
        expect(rows(listed), `${what} list "${prefix}": ${listed.text}`).toBe(0)
        for (const path of pathsOf(target)) expect(listed.text).not.toContain(fileOf(path))
      }
      for (const path of pathsOf(target)) {
        for (const route of ['object', 'object/authenticated', 'object/public', 'object/info']) {
          const read = await send(`${STORAGE}/${route}/${BUCKET}/${path}`, {
            headers: headers(who),
          })
          expect(refused(read), `${what} GET ${route} ${path}: ${read.status}`).toBe(true)
          expect(read.text).not.toContain('PNG')
        }
      }
    }
  })

  it.each(IDENTITIES)('cannot sign a download or an upload URL itself (%s)', async (who) => {
    for (const [what, target] of targets()) {
      for (const path of pathsOf(target)) {
        const one = await send(`${STORAGE}/object/sign/${BUCKET}/${path}`, {
          method: 'POST',
          headers: headers(who, { 'content-type': 'application/json' }),
          body: JSON.stringify({ expiresIn: 600 }),
        })
        expect(refused(one), `${what} sign ${path}: ${one.text}`).toBe(true)
        expect(one.text).not.toMatch(/signedURL"\s*:\s*"/)
      }
      const many = await send(`${STORAGE}/object/sign/${BUCKET}`, {
        method: 'POST',
        headers: headers(who, { 'content-type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 600, paths: pathsOf(target) }),
      })
      expect(many.text, `${what} sign many`).not.toMatch(/signedURL"\s*:\s*"/)
      for (const path of [...openUploadsOf.get(target)!, ...freshPaths(target)]) {
        const upload = await send(`${STORAGE}/object/upload/sign/${BUCKET}/${path}`, {
          method: 'POST',
          headers: headers(who, { 'content-type': 'application/json' }),
          body: '{}',
        })
        expect(refused(upload), `${what} upload sign ${path}: ${upload.text}`).toBe(true)
        expect(upload.text).not.toContain('token=')
      }
    }
  })

  it.each(IDENTITIES)('cannot upload, overwrite or delete objects (%s)', async (who) => {
    for (const [what, target] of targets()) {
      const before = new Map<string, string | undefined>()
      for (const path of pathsOf(target)) before.set(path, await objectEtag(path))
      // New paths of every kind, and the paths the API registered as open uploads (the Storage
      // guard lets Storage write there: only the missing policies stop a client).
      for (const path of [...freshPaths(target), ...openUploadsOf.get(target)!]) {
        for (const method of ['POST', 'PUT']) {
          const put = await send(`${STORAGE}/object/${BUCKET}/${path}`, {
            method,
            ...png(who, { 'x-upsert': 'true' }),
          })
          expect(refused(put), `${what} ${method} ${path}: ${put.text}`).toBe(true)
          expect(await objectEtag(path), `${what} ${method} ${path}`).toBeUndefined()
        }
      }
      for (const path of pathsOf(target)) {
        const overwrite = await send(`${STORAGE}/object/${BUCKET}/${path}`, {
          method: 'PUT',
          ...png(who, { 'x-upsert': 'true' }),
        })
        expect(refused(overwrite), `${what} overwrite ${path}: ${overwrite.text}`).toBe(true)
        await send(`${STORAGE}/object/${BUCKET}/${path}`, {
          method: 'DELETE',
          headers: headers(who),
        })
      }
      await send(`${STORAGE}/object/${BUCKET}`, {
        method: 'DELETE',
        headers: headers(who, { 'content-type': 'application/json' }),
        body: JSON.stringify({ prefixes: pathsOf(target) }),
      })
      for (const path of pathsOf(target)) {
        expect(await objectEtag(path), `${what} ${path} after delete`).toBe(before.get(path))
      }
    }
  })

  it.each(IDENTITIES)('cannot move or copy objects between businesses (%s)', async (who) => {
    for (const [source, destination] of [
      [A, B],
      [B, A],
      [A, A],
    ] as const) {
      for (const sourceKey of pathsOf(source)) {
        for (const route of ['move', 'copy']) {
          const [destinationKey = ''] = freshPaths(destination).slice(1)
          const answer = await send(`${STORAGE}/object/${route}`, {
            method: 'POST',
            headers: headers(who, { 'content-type': 'application/json' }),
            body: JSON.stringify({ bucketId: BUCKET, sourceKey, destinationKey }),
          })
          expect(refused(answer), `${route} ${sourceKey}: ${answer.text}`).toBe(true)
          expect(await objectEtag(destinationKey)).toBeUndefined()
          expect(await objectEtag(sourceKey)).toBeDefined()
        }
      }
    }
  })

  it.each(IDENTITIES)(
    'cannot see, change, empty or delete the bucket, or make one (%s)',
    async (who) => {
      const listed = await send(`${STORAGE}/bucket`, { headers: headers(who) })
      expect(listed.text).not.toContain(BUCKET)
      const bucket = await send(`${STORAGE}/bucket/${BUCKET}`, { headers: headers(who) })
      expect(refused(bucket), bucket.text).toBe(true)
      const json = { 'content-type': 'application/json' }
      const changes: [string, string, unknown][] = [
        [
          'PUT',
          `bucket/${BUCKET}`,
          { public: true, file_size_limit: null, allowed_mime_types: null },
        ],
        ['POST', `bucket/${BUCKET}/empty`, {}],
        ['DELETE', `bucket/${BUCKET}`, {}],
        ['POST', 'bucket', { name: `evil-${newId()}`, public: true }],
      ]
      for (const [method, route, body] of changes) {
        const answer = await send(`${STORAGE}/${route}`, {
          method,
          headers: headers(who, json),
          body: JSON.stringify(body),
        })
        expect(refused(answer), `${method} ${route}: ${answer.text}`).toBe(true)
      }
      const [row] = await api.admin<
        { public: boolean; file_size_limit: string; types: string[] }[]
      >`
      select public, file_size_limit::text, allowed_mime_types as types
        from storage.buckets where id = ${BUCKET}`
      expect(row).toEqual({
        public: false,
        file_size_limit: String(10 * 1024 * 1024),
        types: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
      })
      const [buckets] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from storage.buckets where name like 'evil-%'`
      expect(buckets?.n).toBe(0)
    },
  )

  it('left both businesses’ objects, uploads and rows as they were', async () => {
    expect(await tenantDigest(api.admin, A)).toEqual(digests.A)
    expect(await tenantDigest(api.admin, B)).toEqual(digests.B)
  })
})

describe('signed URLs the API issued', () => {
  /** A copy of a signed-URL token with another path in its payload (the signature kept). */
  function withPayloadUrl(token: string, url: string): string {
    const [header = '', payload = '', signature = ''] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const forged = Buffer.from(JSON.stringify({ ...claims, url })).toString('base64url')
    return `${header}.${forged}.${signature}`
  }

  /** A download URL works for its own object only: not re-pointed, nor with its claim changed. */
  async function expectConfined(url: string, ownPath: string, others: string[]) {
    const signed = new URL(url)
    const token = signed.searchParams.get('token') ?? ''
    const original = await send(signed.toString())
    expect(original.status).toBe(200)
    expect(signed.pathname).toContain(`/object/sign/${BUCKET}/${ownPath}`)
    for (const path of others) {
      const moved = new URL(signed.toString())
      moved.pathname = signed.pathname.replace(ownPath, path)
      const answer = await send(moved.toString())
      expect(refused(answer), `${path}: ${answer.text}`).toBe(true)
      expect(answer.text).not.toContain('PNG')
      // Nor with the token's own claim changed to match (its signature no longer does).
      moved.searchParams.set('token', withPayloadUrl(token, `${BUCKET}/${path}`))
      const forged = await send(moved.toString())
      expect(refused(forged), `${path} (forged claim): ${forged.text}`).toBe(true)
    }
    // A download token does not open the upload route.
    const asUpload = await send(
      `${STORAGE}/object/upload/sign/${BUCKET}/${ownPath}?token=${token}`,
      { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG },
    )
    expect(refused(asUpload), asUpload.text).toBe(true)
  }

  /** An upload URL writes its own path only, once: nowhere else, over nothing. */
  async function expectUploadConfined(
    upload: { uploadUrl: string; path: string; token: string },
    others: string[],
  ) {
    const bBefore = await tenantDigest(api.admin, B)
    const aBefore = new Map<string, string | undefined>()
    for (const path of others) aBefore.set(path, await objectEtag(path))
    for (const path of others) {
      const moved = new URL(upload.uploadUrl)
      moved.pathname = moved.pathname.replace(upload.path, path)
      expect(moved.pathname).toContain(path)
      for (const extra of [{}, { 'x-upsert': 'true' }] as Record<string, string>[]) {
        const answer = await uploadTo(moved.toString(), PNG, 'image/png', extra)
        expect(answer.ok, `${path} ${JSON.stringify(extra)}`).toBe(false)
      }
      moved.searchParams.set('token', withPayloadUrl(upload.token, `${BUCKET}/${path}`))
      const forged = await uploadTo(moved.toString(), PNG, 'image/png')
      expect(forged.ok, `${path} (forged claim)`).toBe(false)
    }
    expect(await tenantDigest(api.admin, B)).toEqual(bBefore)
    for (const path of others) expect(await objectEtag(path), path).toBe(aBefore.get(path))
    // The URL still works for its own path, once.
    expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
    expect(await objectsUnder(A.id)).toContain(upload.path)
  }

  it('a logo’s download URL for business A cannot be re-pointed at business B or another object', async () => {
    const profile = await query<BusinessProfileDto>(api.handler, 'business.profile', {
      token: A.owner.token,
      businessId: A.id,
    })
    await expectConfined(profile.data?.logoUrl ?? '', A.logoPath, [
      B.logoPath,
      ...openUploadsOf.get(B)!,
      ...openUploadsOf.get(A)!,
      objectsOf.get(A)!.purchaseReceipt,
      objectsOf.get(B)!.expenseReceipt,
    ])
  })

  it('a receipt’s download URL for business A cannot be re-pointed at B’s receipts, A’s other one or a logo', async () => {
    for (const [entity, entityId, own] of [
      ['purchase', A.purchase.id, objectsOf.get(A)!.purchaseReceipt],
      ['expense', A.expense.id, objectsOf.get(A)!.expenseReceipt],
    ] as const) {
      const listed = await query<{ data: { items: { url: string | null }[] } }>(
        api.handler,
        'attachment.list',
        { token: A.owner.token, businessId: A.id, input: { entity, entityId } },
      )
      expect(listed.error, listed.raw).toBeUndefined()
      const url = listed.data?.data.items[0]?.url ?? ''
      const others = [...pathsOf(A), ...pathsOf(B), ...openUploadsOf.get(B)!].filter(
        (path) => path !== own,
      )
      await expectConfined(url, own, others)
    }
  })

  it('a logo’s upload URL for business A cannot write into business B, nor over A’s objects', async () => {
    const issued = await mutate<LogoUploadUrlDto>(api.handler, 'business.logoUploadUrl', {
      token: A.owner.token,
      businessId: A.id,
      input: { contentType: 'image/png' },
    })
    await expectUploadConfined(issued.data!, [
      ...freshPaths(B),
      // Issued in B: the Storage guard alone would let Storage write there.
      ...openUploadsOf.get(B)!,
      ...pathsOf(B),
      ...pathsOf(A),
      ...openUploadsOf.get(A)!,
    ])
  })

  it('a receipt’s upload URL for business A cannot write into business B, nor over A’s objects', async () => {
    for (const [entity, entityId] of [
      ['purchase', A.purchase.id],
      ['expense', A.draftExpense.id],
    ] as const) {
      const issued = await mutate<AttachmentUploadUrlDto>(api.handler, 'attachment.uploadUrl', {
        token: A.owner.token,
        businessId: A.id,
        input: { entity, entityId, contentType: 'image/png' },
      })
      expect(issued.error, issued.raw).toBeUndefined()
      await expectUploadConfined(issued.data!, [
        ...freshPaths(B),
        ...openUploadsOf.get(B)!,
        ...pathsOf(B),
        ...pathsOf(A),
        ...openUploadsOf.get(A)!,
      ])
    }
  })
})
