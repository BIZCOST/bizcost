import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  LOGO_URL_TTL_SECONDS,
  type BusinessProfileDto,
  type InvitationPreviewDto,
  type LogoUploadUrlDto,
  type MeDto,
  type MembershipDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIGNING_TIMEOUT_MS } from '../src/admin/storage-admin'
import {
  connectAdmin,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  query,
  SECRET_KEY,
  SUPABASE_URL,
  type Admin,
  type TestUser,
} from './helpers'
import { CapturedEmails, join, setupBusiness, templateRoleId, WORKSHOP } from './settings'

// The business's Arabic name and logo wherever the app names the business (D-097): `me` gives each
// active membership the Arabic name and a short-lived signed logo URL (one Storage request, the
// business's own logo path only, the same URL again while it has time left); a removed or suspended
// member gets nothing of the business; `me` answers without logos when Storage fails or does not
// answer in time. The invitation preview has both names and the email names the business in its own
// language.

let db: Db
let admin: Admin
let handler: ReturnType<typeof handlerFor>
const emails = new CapturedEmails()
const users: TestUser[] = []

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY }, { emailSender: emails })
})

afterAll(async () => {
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

type Person = { user: TestUser; token: string }

async function newUser(): Promise<Person> {
  const user = await createUser({ locale: 'en' })
  users.push(user)
  return { user, token: await mintToken(user) }
}

/** A valid 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** Saves the business's Arabic name through Settings → Business profile. */
async function nameInArabic(owner: Person, businessId: string, legalNameAr: string) {
  const profile = await query<BusinessProfileDto>(handler, 'business.profile', {
    token: owner.token,
    businessId,
  })
  const saved = await mutate(handler, 'business.updateProfile', {
    token: owner.token,
    businessId,
    input: {
      version: profile.data!.version,
      legalName: profile.data!.legalName,
      legalNameAr,
      vatRegistered: profile.data!.vatRegistered,
      trn: profile.data!.vatRegistered ? (profile.data!.trn ?? '100123456700003') : null,
    },
  })
  expect(saved.error).toBeUndefined()
}

/** Uploads and saves a logo; returns its path. */
async function addLogo(owner: Person, businessId: string): Promise<string> {
  const target = await mutate<LogoUploadUrlDto>(handler, 'business.logoUploadUrl', {
    token: owner.token,
    businessId,
    input: { contentType: 'image/png' },
  })
  expect(target.error).toBeUndefined()
  const response = await fetch(target.data!.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'x-upsert': 'false' },
    body: new Uint8Array(PNG),
  })
  expect(response.ok, await response.text()).toBe(true)
  const saved = await mutate(handler, 'business.setLogo', {
    token: owner.token,
    businessId,
    input: { path: target.data!.path },
  })
  expect(saved.error).toBeUndefined()
  return target.data!.path
}

async function memberships(person: Person, on = handler): Promise<MembershipDto[]> {
  const me = await query<MeDto>(on, 'me', { token: person.token })
  expect(me.error).toBeUndefined()
  return me.data!.memberships
}

/**
 * The local Supabase behind a proxy whose Storage never answers (a hung connection); Auth's JWKS
 * still comes through, so tokens are verified as usual.
 */
async function silentStorage() {
  const held = new Set<ServerResponse>()
  let signRequests = 0
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path.startsWith('/storage/')) {
      if (path.startsWith('/storage/v1/object/sign/')) signRequests++
      held.add(res)
      return
    }
    if (req.method !== 'GET') return res.writeHead(502).end()
    void fetch(`${SUPABASE_URL}${path}`).then(async (upstream) => {
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    signRequests: () => signRequests,
    close: async () => {
      for (const res of held) res.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const signedPathOf = (url: string) =>
  decodeURIComponent(new URL(url).pathname).replace('/storage/v1/object/sign/business-files/', '')

describe('me: the Arabic name and the logo of each business', () => {
  it('lists each business with its Arabic name and a signed URL of its own logo', async () => {
    const owner = await newUser()
    const withLogo = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Moon Café' })
    const plain = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Sun Works' })
    await nameInArabic(owner, withLogo, 'مقهى القمر')
    const path = await addLogo(owner, withLogo)

    const listed = await memberships(owner)
    expect(listed.map((m) => [m.businessId, m.legalName, m.legalNameAr])).toEqual([
      [withLogo, 'Moon Café', 'مقهى القمر'],
      [plain, 'Sun Works', null],
    ])
    const [first, second] = listed
    expect(second?.logoUrl).toBeNull()
    // A short-lived signed URL of the private bucket, for this business's own logo object.
    const url = new URL(first!.logoUrl!)
    expect(`${url.origin}`).toBe(new URL(SUPABASE_URL).origin)
    expect(signedPathOf(first!.logoUrl!)).toBe(path)
    expect(path.startsWith(`${withLogo}/logo/`)).toBe(true)
    expect(url.searchParams.get('token')).toBeTruthy()
    const image = await fetch(first!.logoUrl!)
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true)
    // Storage serves it with an Expires header at the URL's own expiry: browsers keep it cached.
    const expires = Date.parse(image.headers.get('expires') ?? '')
    const date = Date.parse(image.headers.get('date') ?? '')
    expect(expires - date).toBeGreaterThan((LOGO_URL_TTL_SECONDS / 2) * 1000 - 5000)
    expect(expires - date).toBeLessThanOrEqual(LOGO_URL_TTL_SECONDS * 1000)
    // Without the token the object is not served.
    const bare = await fetch(`${SUPABASE_URL}/storage/v1/object/business-files/${path}`)
    await bare.arrayBuffer()
    expect(bare.ok).toBe(false)

    // The same URL on the next request while it has time left, so browsers keep the image cached.
    expect((await memberships(owner))[0]?.logoUrl).toBe(first!.logoUrl)
  })

  it('gives members the name and logo too, and a member who leaves or is removed gets nothing', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Moon Café' })
    await nameInArabic(owner, businessId, 'مقهى القمر')
    await addLogo(owner, businessId)
    const employee = await newUser()
    const memberId = await join(db, owner.user, businessId, employee.user, 'employee')

    // An employee cannot open the business profile, but sees the name and the logo in the switcher.
    const [membership] = await memberships(employee)
    expect(membership).toMatchObject({ businessId, legalNameAr: 'مقهى القمر', status: 'active' })
    expect(signedPathOf(membership!.logoUrl!)).toMatch(new RegExp(`^${businessId}/logo/`))

    // Suspended: the business is not listed at all.
    await admin`update app.business_members set status = 'suspended' where id = ${memberId}`
    expect(await memberships(employee)).toEqual([])
    await admin`update app.business_members set status = 'active' where id = ${memberId}`
    expect(await memberships(employee)).toHaveLength(1)

    // Removed: nothing of the business, neither its names nor a logo URL.
    const removed = await mutate(handler, 'member.remove', {
      token: owner.token,
      businessId,
      input: { memberId },
    })
    expect(removed.error).toBeUndefined()
    const me = await query<MeDto>(handler, 'me', { token: employee.token })
    expect(me.data?.memberships).toEqual([])
    expect(JSON.stringify(me.data)).not.toContain(businessId)
    expect(JSON.stringify(me.data)).not.toContain('مقهى القمر')
  })

  it('never signs a path outside the business’s own logo folder', async () => {
    const owner = await newUser()
    const other = await newUser()
    const mine = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Mine' })
    const theirs = await setupBusiness(handler, other.token, WORKSHOP, { name: 'Theirs' })
    const theirLogo = await addLogo(other, theirs)
    // A logo path pointing at another business's object (never written by the API) is not signed.
    await admin`update app.businesses set logo_path = ${theirLogo} where id = ${mine}`
    const [membership] = await memberships(owner)
    expect(membership).toMatchObject({ businessId: mine, logoUrl: null })
    // The other owner still gets their own.
    expect(signedPathOf((await memberships(other))[0]!.logoUrl!)).toBe(theirLogo)
  })

  it('answers without logos when Storage cannot sign them', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Moon Café' })
    await addLogo(owner, businessId)
    const reported: unknown[] = []
    // No secret key: Storage cannot be reached.
    const withoutStorage = handlerFor(db, undefined, {}, { reportError: (e) => reported.push(e) })
    const [membership] = await memberships(owner, withoutStorage)
    expect(membership).toMatchObject({ businessId, legalName: 'Moon Café', logoUrl: null })
    expect(reported).toHaveLength(1)
  })

  it('does not wait for a Storage that does not answer, and then leaves it alone for a while', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Moon Café' })
    await addLogo(owner, businessId)
    const storage = await silentStorage()
    try {
      const reported: unknown[] = []
      const hung = handlerFor(
        db,
        undefined,
        { supabaseUrl: storage.url, supabaseSecretKey: SECRET_KEY },
        { reportError: (e) => reported.push(e) },
      )
      let started = Date.now()
      const [membership] = await memberships(owner, hung)
      expect(Date.now() - started).toBeLessThan(SIGNING_TIMEOUT_MS + 3000)
      expect(membership).toMatchObject({ businessId, legalName: 'Moon Café', logoUrl: null })
      expect(storage.signRequests()).toBe(1)
      expect(reported).toHaveLength(1)

      // The next `me` answers without asking Storage (and without another report).
      started = Date.now()
      expect((await memberships(owner, hung))[0]).toMatchObject({ businessId, logoUrl: null })
      expect(Date.now() - started).toBeLessThan(SIGNING_TIMEOUT_MS)
      expect(storage.signRequests()).toBe(1)
      expect(reported).toHaveLength(1)
    } finally {
      await storage.close()
    }
  })
})

describe('invitations name the business in their own language', () => {
  async function invite(owner: Person, businessId: string, locale: 'en' | 'ar') {
    const email = `invitee-${newId()}@test.bizcost.local`
    const roleId = await templateRoleId(db, owner.user, businessId, 'employee')
    const created = await mutate(handler, 'invitation.create', {
      token: owner.token,
      businessId,
      input: { id: newId(), email, roleId, locale },
    })
    expect(created.error).toBeUndefined()
    const [message] = emails.to(email)
    return { message: message!, token: emails.tokenFor(email) }
  }

  it('an Arabic email and page use the Arabic name; an English email the legal name', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Moon Café' })
    await admin`update app.business_members set display_name = 'Rashed' where business_id = ${businessId}`
    await nameInArabic(owner, businessId, 'مقهى القمر')

    const arabic = await invite(owner, businessId, 'ar')
    expect(arabic.message.subject).toBe('دعوة من Rashed للانضمام إلى مقهى القمر على BizCost')
    expect(arabic.message.html).toContain('<bdi>مقهى القمر</bdi>')
    expect(arabic.message.html).not.toContain('Moon Café')
    expect(arabic.message.text).not.toContain('Moon Café')

    const english = await invite(owner, businessId, 'en')
    expect(english.message.subject).toBe('Rashed invited you to join Moon Café on BizCost')
    expect(english.message.html).not.toContain('مقهى القمر')

    // The page gets both names and shows the one for its language.
    const preview = await query<InvitationPreviewDto>(handler, 'invitation.preview', {
      input: { token: arabic.token },
    })
    expect(preview.data).toMatchObject({ businessName: 'Moon Café', businessNameAr: 'مقهى القمر' })
  })

  it('an Arabic email of a business without an Arabic name uses its legal name', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Sun Works' })
    const { message, token } = await invite(owner, businessId, 'ar')
    expect(message.subject).toContain('Sun Works')
    const preview = await query<InvitationPreviewDto>(handler, 'invitation.preview', {
      input: { token },
    })
    expect(preview.data).toMatchObject({ businessName: 'Sun Works', businessNameAr: null })
  })
})
