import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import type { FeedbackImageUploadDto } from '@bizcost/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  businessDigest,
  createTenant,
  openApi,
  PNG,
  uploadTo,
  type Api,
  type Tenant,
} from './hardening/fixture'
import { connectAdmin, mutate, SECRET_KEY, SUPABASE_URL } from './helpers'

// The scripts of a person's request (docs/ARCHITECTURE.md §Runbooks, D-363): the privacy policy promises
// a copy, erasure and removal, and these are how the owner keeps that promise on a hosted project. They
// run here as he runs them, as postgres, with the id typed in, so a new table or guard cannot quietly
// break them. Against a business with a row in every kind of table the suites know.

const ZERO = '00000000-0000-0000-0000-000000000000'

function script(name: string, id: string, placeholder = ZERO): string {
  const text = readFileSync(
    fileURLToPath(new URL(`../../../supabase/ops/${name}.sql`, import.meta.url)),
    'utf8',
  )
  expect(text.split(placeholder).length - 1, `${name}: one place to type the id`).toBe(1)
  return text.replace(placeholder, id)
}

let api: Api
let tenant: Tenant
let other: Tenant

const storage = () =>
  createClient(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from('business-files')

/** Runs a script as the SQL Editor does: all of it at once, on a connection of its own. */
async function run(sql: string): Promise<{ error: string | null; result: unknown }> {
  const editor = connectAdmin()
  try {
    return { error: null, result: await editor.unsafe(sql) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), result: null }
  } finally {
    await editor.end()
  }
}

beforeAll(async () => {
  api = openApi()
  tenant = await createTenant(api, 'Erase')
  other = await createTenant(api, 'Stays')
}, 180_000)

afterAll(async () => {
  await api.close()
})

describe('export-business.sql', () => {
  it('copies every table the business has rows in, without the hashes, and changes nothing', async () => {
    const before = await businessDigest(api.admin, tenant.id)
    const { error, result } = await run(script('export-business', tenant.id))
    expect(error).toBeNull()
    const rows = (result as Record<string, unknown>[]).at(-1) as unknown as {
      table_name: string
      row_count: string
      rows: Record<string, unknown>[]
    }[]
    const tables = rows.map((row) => row.table_name)
    expect(tables).toEqual(
      expect.arrayContaining(['businesses', 'business_members', 'audit_log', 'materials']),
    )
    expect(rows.find((row) => row.table_name === 'businesses')?.rows[0]?.id).toBe(tenant.id)
    for (const row of rows) {
      for (const item of row.rows) {
        expect(Object.keys(item)).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^(request|pin|token|file)_hash$/)]),
        )
        if ('business_id' in item) expect(item.business_id).toBe(tenant.id)
      }
    }
    expect(await businessDigest(api.admin, tenant.id)).toEqual(before)
  })

  it('says so when no business has the id', async () => {
    const { error } = await run(script('export-business', ZERO.replace(/0$/, '1')))
    expect(error).toMatch(/no business has the id/)
  })
})

describe('erase-business.sql', () => {
  const erase = () => run(script('erase-business', tenant.id))

  it('refuses an open business, and changes nothing', async () => {
    const before = await businessDigest(api.admin, tenant.id)
    expect((await erase()).error).toMatch(/not a closed business/)
    expect(await businessDigest(api.admin, tenant.id)).toEqual(before)
  })

  it('refuses a closed one with issued tax documents, which the law keeps', async () => {
    await api.admin`update app.businesses set deleted_at = now() where id = ${tenant.id}`
    const [issued] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.invoices
       where business_id = ${tenant.id} and status = 'issued'`
    expect(issued?.n).toBeGreaterThan(0)
    expect((await erase()).error).toMatch(/issued tax documents/)
  })

  it('refuses while its files are in Storage, and says which folder', async () => {
    // The law's part aside (a business with none issued is what reaches this).
    await api.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`delete from app.credit_notes where business_id = ${tenant.id} and status = 'issued'`
      await tx`delete from app.invoices where business_id = ${tenant.id} and status = 'issued'`
    })
    const { error } = await erase()
    expect(error).toMatch(/still has \d+ files/)
    expect(error).toContain(tenant.id)
  })

  it('and while a picture of its feedback is there', async () => {
    const sent = await feedbackFromTheBusiness()
    await removeFiles()
    const { error } = await erase()
    expect(error).toContain(sent.path)
    expect((await storage().remove([sent.path])).error).toBeNull()
  })

  it('then erases every row of it, and nothing of anyone else', async () => {
    const others = await businessDigest(api.admin, other.id)
    expect((await erase()).error).toBeNull()

    const tables = await api.admin<{ name: string }[]>`
      select c.relname as name from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id'
       where n.nspname = 'app' and c.relkind = 'r'`
    for (const { name } of tables) {
      const [row] = await api.admin.unsafe<{ n: number }[]>(
        `select count(*)::int as n from app."${name}" where business_id = $1`,
        [tenant.id],
      )
      expect(row?.n, name).toBe(0)
    }
    const [business] = await api.admin`select 1 as one from app.businesses where id = ${tenant.id}`
    expect(business).toBeUndefined()
    const [feedback] = await api.admin`
      select 1 as one from app.feedback where from_business_id = ${tenant.id}`
    expect(feedback).toBeUndefined()
    const [pointer] = await api.admin`
      select 1 as one from app.profiles where last_business_id = ${tenant.id}`
    expect(pointer).toBeUndefined()
    expect(await businessDigest(api.admin, other.id)).toEqual(others)
  })

  it('leaves the guards on afterwards: the setting ended with its transaction', async () => {
    const [setting] = await api.admin<{ value: string }[]>`
      select current_setting('session_replication_role') as value`
    expect(setting?.value).toBe('origin')
  })

  /** A picture sent from the business while it was open (the row is what the check reads). */
  async function feedbackFromTheBusiness() {
    await api.admin`update app.businesses set deleted_at = null where id = ${tenant.id}`
    const issued = await mutate<FeedbackImageUploadDto>(api.handler, 'feedback.imageUploadUrl', {
      token: tenant.owner.token,
      input: { contentType: 'image/png' },
    })
    await uploadTo(issued.data!.uploadUrl, PNG, 'image/png')
    const sent = await mutate(api.handler, 'feedback.send', {
      token: tenant.owner.token,
      businessId: tenant.id,
      input: { message: 'with a picture', pagePath: '/', imagePath: issued.data!.path },
    })
    expect(sent.error).toBeUndefined()
    await api.admin`update app.businesses set deleted_at = now() where id = ${tenant.id}`
    return { path: issued.data!.path }
  }

  async function removeFiles() {
    const rows = await api.admin<{ name: string }[]>`
      select name from storage.objects
       where bucket_id = 'business-files' and split_part(name, '/', 1) = ${tenant.id}`
    const { error } = await storage().remove(rows.map((row) => row.name))
    expect(error).toBeNull()
  }
})

describe('remove-feedback.sql', () => {
  it('stops while the picture is there, then removes the row', async () => {
    const issued = await mutate<FeedbackImageUploadDto>(api.handler, 'feedback.imageUploadUrl', {
      token: other.owner.token,
      input: { contentType: 'image/png' },
    })
    await uploadTo(issued.data!.uploadUrl, PNG, 'image/png')
    const sent = await mutate(api.handler, 'feedback.send', {
      token: other.owner.token,
      input: { message: 'please remove', pagePath: '/', imagePath: issued.data!.path },
    })
    expect(sent.error).toBeUndefined()
    const [row] = await api.admin<{ id: string }[]>`
      select id from app.feedback where image_path = ${issued.data!.path}`

    const first = await run(script('remove-feedback', row!.id))
    expect(first.error).toContain(issued.data!.path)
    const [kept] = await api.admin`select 1 as one from app.feedback where id = ${row!.id}`
    expect(kept).toBeDefined()

    expect((await storage().remove([issued.data!.path])).error).toBeNull()
    expect((await run(script('remove-feedback', row!.id))).error).toBeNull()
    const [gone] = await api.admin`select 1 as one from app.feedback where id = ${row!.id}`
    expect(gone).toBeUndefined()
  })

  it('says so when no feedback has the id', async () => {
    expect((await run(script('remove-feedback', ZERO.replace(/0$/, '1')))).error).toMatch(
      /no feedback has the id/,
    )
  })
})

describe('remove-person-traces.sql', () => {
  const NOTE = 'person@example.com'

  it('stops while the address has an account', async () => {
    const { error } = await run(script('remove-person-traces', other.owner.user.email, NOTE))
    expect(error).toMatch(/still has an account/)
  })

  it('takes the list’s row, closed invitations and the sign-in log, not someone else’s', async () => {
    const stamp = Date.now()
    const gone = `ops-gone-${stamp}@test.bizcost.local`
    const stays = `ops-stays-${stamp}@test.bizcost.local`
    await api.admin`insert into app.beta_list (email, note) values (${gone}, 'who it is'), (${stays}, 'x')`
    await api.admin`
      insert into auth.audit_log_entries (id, payload, created_at)
      values (gen_random_uuid(), ${api.admin.json({ traits: { user_email: gone } })}, now()),
             (gen_random_uuid(), ${api.admin.json({ traits: { user_email: stays } })}, now())`
    await api.admin`
      update app.business_invitations set email = ${gone}, status = 'revoked'
       where business_id = ${other.id} and id = ${other.invitation.id}`

    expect((await run(script('remove-person-traces', gone, NOTE))).error).toBeNull()

    const list = await api.admin<{ email: string }[]>`
      select email::text from app.beta_list where email::text in (${gone}, ${stays})`
    expect(list.map((row) => row.email)).toEqual([stays])
    const [invitation] = await api.admin`
      select 1 as one from app.business_invitations where email = ${gone}`
    expect(invitation).toBeUndefined()
    const log = await api.admin<{ email: string }[]>`
      select payload->'traits'->>'user_email' as email from auth.audit_log_entries
       where payload->'traits'->>'user_email' in (${gone}, ${stays})`
    expect(log.map((row) => row.email)).toEqual([stays])

    await api.admin`delete from app.beta_list where email::text = ${stays}`
    await api.admin`
      delete from auth.audit_log_entries where payload->'traits'->>'user_email' = ${stays}`
  })
})
