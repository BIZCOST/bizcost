import type { BusinessProfileDto, LogoUploadUrlDto } from '@bizcost/contracts'
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
//   - Storage, bucket business-files: list, read, sign, upload (also at a path the API registered as
//     an open upload, which the Storage guard would let through), overwrite, delete, move, copy and
//     bucket changes, in the caller's own business and in another: all refused, and both businesses'
//     objects and rows are unchanged;
//   - signed URLs the API issued for business A cannot be re-pointed at business B (or at another
//     path of A), nor used with a tampered token.
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

  it.each(IDENTITIES)('lists nothing and reads nothing (%s)', async (who) => {
    for (const [what, target] of targets()) {
      for (const prefix of ['', `${target.id}/`, `${target.id}/logo/`, `${target.id}/logo`]) {
        const listed = await send(`${STORAGE}/object/list/${BUCKET}`, {
          method: 'POST',
          headers: headers(who, { 'content-type': 'application/json' }),
          body: JSON.stringify({ prefix, limit: 100 }),
        })
        expect(rows(listed), `${what} list "${prefix}": ${listed.text}`).toBe(0)
        expect(listed.text).not.toContain(target.logoPath.split('/').at(-1))
      }
      for (const route of ['object', 'object/authenticated', 'object/public', 'object/info']) {
        const read = await send(`${STORAGE}/${route}/${BUCKET}/${target.logoPath}`, {
          headers: headers(who),
        })
        expect(refused(read), `${what} GET ${route}: ${read.status}`).toBe(true)
        expect(read.text).not.toContain('PNG')
      }
    }
  })

  it.each(IDENTITIES)('cannot sign a download or an upload URL itself (%s)', async (who) => {
    for (const [what, target] of targets()) {
      const one = await send(`${STORAGE}/object/sign/${BUCKET}/${target.logoPath}`, {
        method: 'POST',
        headers: headers(who, { 'content-type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 600 }),
      })
      expect(refused(one), `${what} sign: ${one.text}`).toBe(true)
      expect(one.text).not.toMatch(/signedURL"\s*:\s*"/)
      const many = await send(`${STORAGE}/object/sign/${BUCKET}`, {
        method: 'POST',
        headers: headers(who, { 'content-type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 600, paths: [target.logoPath] }),
      })
      expect(many.text, `${what} sign many`).not.toMatch(/signedURL"\s*:\s*"/)
      for (const path of [target.openUpload.path, `${target.id}/logo/${newId()}.png`]) {
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
      const logoBefore = await objectEtag(target.logoPath)
      expect(logoBefore, `${what} has a logo object`).toBeDefined()
      // A new path, and the path the API registered as an open upload (the Storage guard lets
      // Storage write there: only the missing policies stop a client).
      for (const path of [`${target.id}/logo/${newId()}.png`, target.openUpload.path]) {
        for (const method of ['POST', 'PUT']) {
          const put = await send(`${STORAGE}/object/${BUCKET}/${path}`, {
            method,
            ...png(who, { 'x-upsert': 'true' }),
          })
          expect(refused(put), `${what} ${method} ${path}: ${put.text}`).toBe(true)
          expect(await objectEtag(path), `${what} ${method} ${path}`).toBeUndefined()
        }
      }
      const overwrite = await send(`${STORAGE}/object/${BUCKET}/${target.logoPath}`, {
        method: 'PUT',
        ...png(who, { 'x-upsert': 'true' }),
      })
      expect(refused(overwrite), `${what} overwrite: ${overwrite.text}`).toBe(true)

      await send(`${STORAGE}/object/${BUCKET}/${target.logoPath}`, {
        method: 'DELETE',
        headers: headers(who),
      })
      await send(`${STORAGE}/object/${BUCKET}`, {
        method: 'DELETE',
        headers: headers(who, { 'content-type': 'application/json' }),
        body: JSON.stringify({ prefixes: [target.logoPath] }),
      })
      expect(await objectEtag(target.logoPath), `${what} logo after delete`).toBe(logoBefore)
    }
  })

  it.each(IDENTITIES)('cannot move or copy objects between businesses (%s)', async (who) => {
    for (const [source, destination] of [
      [A, B],
      [B, A],
      [A, A],
    ] as const) {
      for (const route of ['move', 'copy']) {
        const destinationKey = `${destination.id}/logo/${newId()}.png`
        const answer = await send(`${STORAGE}/object/${route}`, {
          method: 'POST',
          headers: headers(who, { 'content-type': 'application/json' }),
          body: JSON.stringify({ bucketId: BUCKET, sourceKey: source.logoPath, destinationKey }),
        })
        expect(refused(answer), `${route}: ${answer.text}`).toBe(true)
        expect(await objectEtag(destinationKey)).toBeUndefined()
        expect(await objectEtag(source.logoPath)).toBeDefined()
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

  it('a download URL for business A cannot be re-pointed at business B or another object', async () => {
    const profile = await query<BusinessProfileDto>(api.handler, 'business.profile', {
      token: A.owner.token,
      businessId: A.id,
    })
    const signed = new URL(profile.data?.logoUrl ?? '')
    const token = signed.searchParams.get('token') ?? ''
    const original = await send(signed.toString())
    expect(original.status).toBe(200)

    const ownPrefix = `/object/sign/${BUCKET}/${A.logoPath}`
    expect(signed.pathname).toContain(ownPrefix)
    for (const path of [B.logoPath, B.openUpload.path, A.openUpload.path]) {
      const moved = new URL(signed.toString())
      moved.pathname = signed.pathname.replace(A.logoPath, path)
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
      `${STORAGE}/object/upload/sign/${BUCKET}/${A.logoPath}?token=${token}`,
      { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG },
    )
    expect(refused(asUpload), asUpload.text).toBe(true)
  })

  it('an upload URL for business A cannot write into business B, nor over A’s logo', async () => {
    const issued = await mutate<LogoUploadUrlDto>(api.handler, 'business.logoUploadUrl', {
      token: A.owner.token,
      businessId: A.id,
      input: { contentType: 'image/png' },
    })
    const upload = issued.data!
    const bBefore = await tenantDigest(api.admin, B)
    const aLogo = await objectEtag(A.logoPath)
    const targets = [
      `${B.id}/logo/${newId()}.png`,
      // Issued in B: the Storage guard alone would let Storage write there.
      B.openUpload.path,
      B.logoPath,
      A.logoPath,
      A.openUpload.path,
    ]
    for (const path of targets) {
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
    expect(await objectEtag(A.logoPath)).toBe(aLogo)
    expect(await objectEtag(A.openUpload.path)).toBeUndefined()
    // The URL still works for its own path, once.
    expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
    expect(await objectsUnder(A.id)).toContain(upload.path)
  })
})
