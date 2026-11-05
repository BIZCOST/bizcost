import { randomUUID } from 'node:crypto'
import { startHookedAuth, type HookedAuth } from '@bizcost/config/testing/hooked-auth'
import {
  LEGAL_METADATA_KEY,
  LEGAL_VERSION,
  type BetaEntryDto,
  type BetaListDto,
  type BusinessContextDto,
  type FeedbackImageUploadDto,
  type MeDto,
  type PlatformFeedbackDto,
  type ProfileDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EmailMessage, EmailSender } from '../src'
import { PNG, uploadTo } from './hardening/fixture'
import {
  connectAdmin,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  ORIGIN,
  query,
  SECRET_KEY,
  type Admin,
  type TestUser,
} from './helpers'
import { appCode, join, setupBusiness, templateRoleId, WORKSHOP } from './settings'

// The closed beta (D-355–D-359): attacks on the Auth hook through a real Auth server with it on, on the
// owner's beta page, on "Send feedback" and on the terms; held modules are in beta-held.api.test.ts.

const db = connectApi()
let admin: Admin
let auth: HookedAuth
const users: TestUser[] = []
const addresses = new Set<string>()

/** A new address; letters only, as the other Auth tests (no digits to look like a code). */
function address(label: string): string {
  const letters = randomUUID()
    .replace(/-/g, '')
    .slice(0, 12)
    .replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)))
  const email = `beta-${label}-${letters}@test.bizcost.local`
  addresses.add(email)
  return email
}

async function person(metadata: Record<string, unknown> = {}, email?: string) {
  const user = await createUser(metadata, email ? { email } : {})
  users.push(user)
  return { user, token: await mintToken(user) }
}

class Mailbox implements EmailSender {
  readonly sent: EmailMessage[] = []
  fail = false
  send(message: EmailMessage): Promise<void> {
    if (this.fail) return Promise.reject(new Error('smtp down'))
    this.sent.push(message)
    return Promise.resolve()
  }
}

const OWNER_EMAIL = `platform-owner-${newId()}@test.bizcost.local`
const FEEDBACK_TO = `feedback-${newId()}@test.bizcost.local`
const reported: unknown[] = []
const mailbox = new Mailbox()
const handler = handlerFor(
  db,
  undefined,
  {
    supabaseSecretKey: SECRET_KEY,
    platformAdmins: [OWNER_EMAIL.toLowerCase()],
    feedbackEmail: FEEDBACK_TO,
  },
  { emailSender: mailbox, reportError: (error) => reported.push(error) },
)

beforeAll(async () => {
  admin = connectAdmin()
  auth = await startHookedAuth()
}, 120_000)

afterAll(async () => {
  await auth?.stop()
  await admin`delete from app.beta_list where email::text = any(${[...addresses]})`
  await admin`delete from app.feedback where user_id = any(${users.map((user) => user.id)}::uuid[])`
  const ids = await admin<{ id: string }[]>`
    select id from auth.users where email = any(${[...addresses]})`
  for (const { id } of ids) {
    await deleteUser({ id, email: '', password: '', metadata: {} })
  }
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

async function authCall(path: string, body: object) {
  const response = await fetch(`${auth.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const signUp = (email: string) =>
  authCall('/signup', { email, password: 'abcdefg1', data: { locale: 'en' } })
const askForCode = (email: string) =>
  authCall('/otp', { email, create_user: true, data: { locale: 'en' } })

async function accountExists(email: string): Promise<boolean> {
  const rows = await admin`select 1 from auth.users where email = ${email.toLowerCase()}`
  return rows.length > 0
}

const list = (email: string, note: string | null = null) =>
  admin`insert into app.beta_list (email, note) values (${email.toLowerCase()}, ${note})`

/** A request from the app's own origin, past the CSRF check: what is left to answer is the session. */
const FROM_APP = { origin: ORIGIN }

const REFUSED = { status: 403, message: 'beta_invite_only' }
const refusedAs = (answer: { status: number; body: Record<string, unknown> }) => ({
  status: answer.status,
  message: answer.body.msg,
})

describe('closed sign-up: the Auth hook, through a real Auth server', () => {
  it('refuses an address on no list, by every way Auth creates a user, and makes no account', async () => {
    const email = address('stranger')
    expect(refusedAs(await signUp(email))).toEqual(REFUSED)
    expect(refusedAs(await askForCode(email))).toEqual(REFUSED)
    expect(refusedAs(await authCall('/magiclink', { email }))).toEqual(REFUSED)
    expect(await accountExists(email)).toBe(false)
  })

  it('lets through an address on the beta list, in any spelling of its case', async () => {
    const signingUp = address('listed')
    await list(signingUp)
    expect((await signUp(signingUp)).status).toBe(200)
    expect(await accountExists(signingUp)).toBe(true)

    const byCode = address('listed-code')
    await list(byCode)
    expect((await askForCode(byCode)).status).toBe(200)
    expect(await accountExists(byCode)).toBe(true)

    const shouted = address('listed-upper')
    await list(shouted)
    expect((await signUp(shouted.toUpperCase())).status).toBe(200)
    expect(await accountExists(shouted)).toBe(true)
  })

  it('refuses an address taken off the list', async () => {
    const email = address('removed')
    await list(email)
    await admin`update app.beta_list set removed_at = now() where email::text = ${email}`
    expect(refusedAs(await signUp(email))).toEqual(REFUSED)
  })

  it('tells nothing about the list: the same words for everyone refused, none of them an address', async () => {
    const onList = address('near')
    await list(onList)
    const answers = await Promise.all([
      signUp(address('other')),
      signUp(`${onList.split('@')[0]}x@test.bizcost.local`),
      askForCode(address('another')),
    ])
    addresses.add(`${onList.split('@')[0]}x@test.bizcost.local`)
    for (const answer of answers) {
      expect(answer.status).toBe(403)
      expect(answer.body.msg).toBe('beta_invite_only')
      expect(JSON.stringify(answer.body)).not.toContain('@')
    }
  })

  it('does not stand in the way of an account that exists: its own sign-in code still goes', async () => {
    const existing = await person()
    addresses.add(existing.user.email)
    expect((await askForCode(existing.user.email)).status).toBe(200)
    // Signing up again: the answer an address gets anyway, and still one account (D-062).
    expect((await signUp(existing.user.email)).status).toBe(200)
    const rows = await admin`select 1 from auth.users where email = ${existing.user.email}`
    expect(rows).toHaveLength(1)
  })

  describe('an invitation from a business opens the door only while it could be accepted', () => {
    let owner: { user: TestUser; token: string }
    let businessId: string
    let roleId: string

    beforeAll(async () => {
      owner = await person()
      businessId = await setupBusiness(handler, owner.token, WORKSHOP)
      roleId = await templateRoleId(db, owner.user, businessId, 'employee')
    })

    async function invite(email: string): Promise<string> {
      const id = newId()
      const result = await mutate(handler, 'invitation.create', {
        token: owner.token,
        businessId,
        input: { id, email, roleId, locale: 'en' },
      })
      expect(result.error).toBeUndefined()
      return id
    }

    it('a pending invitation lets its address in; another address is still refused', async () => {
      const invited = address('invited')
      await invite(invited)
      expect(refusedAs(await signUp(address('not-invited')))).toEqual(REFUSED)
      expect((await signUp(invited)).status).toBe(200)
      expect(await accountExists(invited)).toBe(true)
    })

    it('an expired one does not', async () => {
      const email = address('expired')
      const id = await invite(email)
      await admin`update app.business_invitations set expires_at = now() - interval '1 minute'
                   where id = ${id}`
      expect(refusedAs(await signUp(email))).toEqual(REFUSED)
    })

    it('a revoked one does not', async () => {
      const email = address('revoked')
      const id = await invite(email)
      const revoked = await mutate(handler, 'invitation.revoke', {
        token: owner.token,
        businessId,
        input: { id },
      })
      expect(revoked.error).toBeUndefined()
      expect(refusedAs(await askForCode(email))).toEqual(REFUSED)
    })

    it('one whose inviter may no longer invite does not', async () => {
      const lead = await person()
      await join(db, owner.user, businessId, lead.user, 'admin')
      const email = address('inviter-gone')
      const made = await mutate(handler, 'invitation.create', {
        token: lead.token,
        businessId,
        input: { id: newId(), email, roleId, locale: 'en' },
      })
      expect(made.error).toBeUndefined()
      await admin`update app.business_members set status = 'removed'
                   where business_id = ${businessId} and user_id = ${lead.user.id}`
      expect(refusedAs(await signUp(email))).toEqual(REFUSED)
    })

    it('one from a deleted business does not', async () => {
      const other = await person()
      const closed = await setupBusiness(handler, other.token, WORKSHOP)
      const closedRole = await templateRoleId(db, other.user, closed, 'employee')
      const email = address('closed-business')
      const made = await mutate(handler, 'invitation.create', {
        token: other.token,
        businessId: closed,
        input: { id: newId(), email, roleId: closedRole, locale: 'en' },
      })
      expect(made.error).toBeUndefined()
      await admin`update app.businesses set deleted_at = now() where id = ${closed}`
      expect(refusedAs(await signUp(email))).toEqual(REFUSED)
    })
  })

  it('off by default: the shared local stack takes any address (the other suites rely on it)', async () => {
    const email = address('open')
    const response = await fetch(`${process.env.SUPABASE_API_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password: 'abcdefg1' }),
    })
    expect(response.status).toBe(200)
    expect(await accountExists(email)).toBe(true)
  })
})

describe('the owner’s beta page: platform admins only', () => {
  const PROCEDURES: readonly {
    path: string
    call: typeof query | typeof mutate
    input?: unknown
  }[] = [
    { path: 'platform.betaList', call: query },
    { path: 'platform.feedback', call: query, input: {} },
    { path: 'platform.betaAdd', call: mutate, input: { email: 'x@example.test' } },
    { path: 'platform.betaRemove', call: mutate, input: { id: newId() } },
  ]
  let owner: { user: TestUser; token: string }

  beforeAll(async () => {
    owner = await person({}, OWNER_EMAIL)
  })

  it('signed out: UNAUTHORIZED, every procedure', async () => {
    for (const { path, call, input } of PROCEDURES) {
      expect(appCode(await call(handler, path, { input, headers: FROM_APP })), path).toBe(
        'unauthorized',
      )
    }
  })

  it('a signed-in person, even the owner of a business: FORBIDDEN, every procedure', async () => {
    const stranger = await person()
    const businessOwner = await person()
    const businessId = await setupBusiness(handler, businessOwner.token, WORKSHOP)
    for (const { path, call, input } of PROCEDURES) {
      expect(appCode(await call(handler, path, { token: stranger.token, input })), path).toBe(
        'forbidden',
      )
      expect(
        appCode(await call(handler, path, { token: businessOwner.token, businessId, input })),
        path,
      ).toBe('forbidden')
    }
  })

  it('an admin’s address in a token of someone else: FORBIDDEN (Auth’s own row decides)', async () => {
    const attacker = await person()
    const forged = await mintToken({ ...attacker.user, email: OWNER_EMAIL })
    for (const { path, call, input } of PROCEDURES) {
      expect(appCode(await call(handler, path, { token: forged, input })), path).toBe('forbidden')
    }
  })

  it('an admin’s address not yet confirmed: FORBIDDEN (a stranger could have signed it up)', async () => {
    const email = address('unconfirmed-admin')
    const unconfirmed = await createUser({}, { email, confirmed: false })
    users.push(unconfirmed)
    const handlerOf = handlerFor(db, undefined, { platformAdmins: [email] })
    const token = await mintToken(unconfirmed)
    expect(appCode(await query(handlerOf, 'platform.betaList', { token }))).toBe('forbidden')
    const me = await query<MeDto>(handlerOf, 'me', { token })
    expect(me.data?.isPlatformAdmin).toBe(false)
  })

  it('with no admins set, nobody; a cookie write from another origin is refused too', async () => {
    const closed = handlerFor(db, undefined, { platformAdmins: [] })
    expect(appCode(await query(closed, 'platform.betaList', { token: owner.token }))).toBe(
      'forbidden',
    )
    const request = await handler(
      new Request(`${ORIGIN}/api/trpc/platform.betaAdd`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'sb-x-auth-token=y',
          origin: 'https://evil.example',
        },
        body: JSON.stringify({ email: 'x@example.test' }),
      }),
    )
    expect(request.status).toBe(403)
  })

  it('`me` tells the admin and nobody else, and is not fooled by the case of an address', async () => {
    const stranger = await person()
    expect((await query<MeDto>(handler, 'me', { token: owner.token })).data?.isPlatformAdmin).toBe(
      true,
    )
    expect(
      (await query<MeDto>(handler, 'me', { token: stranger.token })).data?.isPlatformAdmin,
    ).toBe(false)
  })

  it('the list: adds in lower case, again only changes the note, takes off, adds back', async () => {
    const email = address('page')
    const added = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token: owner.token,
      input: { email: email.toUpperCase(), note: 'first' },
    })
    expect(added.data).toMatchObject({ email, note: 'first' })
    const again = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token: owner.token,
      input: { email, note: 'second' },
    })
    expect(again.data?.id).toBe(added.data?.id)
    expect(again.data?.note).toBe('second')
    const kept = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token: owner.token,
      input: { email },
    })
    expect(kept.data?.note).toBe('second')

    const listed = await query<BetaListDto>(handler, 'platform.betaList', { token: owner.token })
    expect(listed.data?.items.filter((item) => item.email === email)).toHaveLength(1)

    const id = added.data!.id
    const removed = await mutate(handler, 'platform.betaRemove', {
      token: owner.token,
      input: { id },
    })
    expect(removed.error).toBeUndefined()
    expect(
      appCode(await mutate(handler, 'platform.betaRemove', { token: owner.token, input: { id } })),
    ).toBe('not_found')
    const after = await query<BetaListDto>(handler, 'platform.betaList', { token: owner.token })
    expect(after.data?.items.some((item) => item.email === email)).toBe(false)
    const [row] = await admin<{ removed_by: string }[]>`
      select removed_by from app.beta_list where id = ${id}`
    expect(row?.removed_by).toBe(owner.user.id)

    const back = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token: owner.token,
      input: { email },
    })
    expect(back.data?.id).not.toBe(id)
  })

  it('refuses what is not an address, a note out of bounds, and a note with control characters', async () => {
    for (const input of [
      { email: 'not-an-address' },
      { email: 'a@b.test\nbcc:x@y.test' },
      { email: `${'a'.repeat(300)}@b.test` },
      { email: 'a@b.test', note: 'n'.repeat(201) },
      { email: 'a@b.test', note: 'tab\there' },
      { email: "a'; drop table app.beta_list; --@b.test" },
    ]) {
      expect(
        appCode(await mutate(handler, 'platform.betaAdd', { token: owner.token, input })),
        JSON.stringify(input),
      ).toBe('validation')
    }
  })

  it('a deleted account’s token is refused even if its address is an admin’s', async () => {
    const email = address('deleted-admin')
    const gone = await person({}, email)
    const handlerOf = handlerFor(db, undefined, { platformAdmins: [email] })
    await query(handlerOf, 'me', { token: gone.token })
    await admin`update app.profiles set anonymized_at = now() where id = ${gone.user.id}`
    expect(appCode(await query(handlerOf, 'platform.betaList', { token: gone.token }))).toBe(
      'unauthorized',
    )
  })
})

describe('Send feedback', () => {
  const PAGE = '/b/0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e6f/sales'
  let owner: { user: TestUser; token: string }

  beforeAll(async () => {
    owner = await person({}, OWNER_EMAIL.replace('platform-owner', 'platform-reader'))
  })

  /** What the database holds, read as `postgres`. */
  async function stored(userId: string) {
    return admin<
      {
        id: string
        message: string
        page_path: string
        from_business_id: string | null
        from_member_id: string | null
        image_path: string | null
      }[]
    >`select id, message, page_path, from_business_id, from_member_id, image_path
        from app.feedback where user_id = ${userId} order by id`
  }

  const send = (token: string, input: object, businessId?: string) =>
    mutate(handler, 'feedback.send', { token, input, ...(businessId ? { businessId } : {}) })

  it('needs a session', async () => {
    expect(appCode(await mutate(handler, 'feedback.send', { input: {}, headers: FROM_APP }))).toBe(
      'unauthorized',
    )
    expect(
      appCode(
        await mutate(handler, 'feedback.imageUploadUrl', {
          input: { contentType: 'image/png' },
          headers: FROM_APP,
        }),
      ),
    ).toBe('unauthorized')
  })

  it('from a business: the database writes its business and member, whatever is sent', async () => {
    const member = await person()
    const businessId = await setupBusiness(handler, member.token, WORKSHOP)
    const result = await send(
      member.token,
      {
        message: 'The total looks wrong',
        pagePath: PAGE,
        // Not in the input: stripped, and the database would overwrite them anyway.
        fromBusinessId: newId(),
        userId: owner.user.id,
      },
      businessId,
    )
    expect(result.error).toBeUndefined()
    const [row] = await stored(member.user.id)
    expect(row).toMatchObject({
      message: 'The total looks wrong',
      page_path: PAGE,
      from_business_id: businessId,
    })
    expect(row?.from_member_id).not.toBeNull()
    expect(await stored(owner.user.id)).toEqual([])
  })

  it('outside any business (Smart Setup, the account): saved with neither', async () => {
    const newcomer = await person()
    expect((await send(newcomer.token, { message: 'Stuck', pagePath: '/setup' })).error).toBe(
      undefined,
    )
    expect((await stored(newcomer.user.id))[0]).toMatchObject({
      from_business_id: null,
      from_member_id: null,
    })
  })

  it('from another business’s page: FORBIDDEN, and nothing is saved', async () => {
    const victim = await person()
    const victimBusiness = await setupBusiness(handler, victim.token, WORKSHOP)
    const attacker = await person()
    expect(
      appCode(await send(attacker.token, { message: 'x', pagePath: '/' }, victimBusiness)),
    ).toBe('forbidden')
    expect(await stored(attacker.user.id)).toEqual([])
    const malformed = await mutate(handler, 'feedback.send', {
      token: attacker.token,
      headers: { 'x-business-id': 'not-a-uuid' },
      input: { message: 'x', pagePath: '/' },
    })
    expect(appCode(malformed)).toBe('validation')
  })

  it('takes the page’s path alone: a query, a fragment or another site is refused', async () => {
    const sender = await person()
    for (const pagePath of [
      '/b/x?token=secret',
      '/b/x#fragment',
      'https://evil.example/b/x',
      '//evil.example',
      'javascript:alert(1)',
      '/<script>',
      '/b x',
      '/line\nbreak',
      `/${'a'.repeat(300)}`,
      '',
    ]) {
      expect(
        appCode(await send(sender.token, { message: 'x', pagePath })),
        JSON.stringify(pagePath),
      ).toBe('validation')
    }
    expect(await stored(sender.user.id)).toEqual([])
  })

  it('a message: not empty, not too long, keeps its lines and refuses other control characters', async () => {
    const sender = await person()
    for (const message of ['', '   \n ', 'm'.repeat(4001), 'nul\u0000here', 'bell\u0007']) {
      expect(appCode(await send(sender.token, { message, pagePath: '/' }))).toBe('validation')
    }
    expect((await send(sender.token, { message: 'two\nlines', pagePath: '/' })).error).toBe(
      undefined,
    )
    expect((await stored(sender.user.id))[0]?.message).toBe('two\nlines')
  })

  it('emails the owner, HTML escaped, no user text in the subject, replies going to the sender', async () => {
    const sender = await person()
    const businessId = await setupBusiness(handler, sender.token, WORKSHOP, { name: 'Sara & Co' })
    mailbox.sent.length = 0
    await send(
      sender.token,
      { message: '<img src=x onerror=alert(1)>', pagePath: PAGE },
      businessId,
    )
    const message = mailbox.sent.at(-1)
    expect(message?.to).toBe(FEEDBACK_TO)
    expect(message?.replyTo).toBe(sender.user.email)
    expect(message?.subject).not.toContain('Sara')
    expect(message?.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(message?.html).not.toContain('<img src=x')
    expect(message?.html).toContain('Sara &amp; Co')
    expect(message?.html).toContain(PAGE)
    expect(message?.text).toContain('<img src=x onerror=alert(1)>')
  })

  it('a failed email never loses the feedback, and the sender is not told', async () => {
    const sender = await person()
    mailbox.fail = true
    reported.length = 0
    const result = await send(sender.token, { message: 'Kept', pagePath: '/account' })
    mailbox.fail = false
    expect(result.error).toBeUndefined()
    expect((await stored(sender.user.id))[0]?.message).toBe('Kept')
    expect(reported).toHaveLength(1)
  })

  it('without an address set, it is only saved', async () => {
    const quiet = new Mailbox()
    const handlerOf = handlerFor(db, undefined, {}, { emailSender: quiet })
    const sender = await person()
    const result = await mutate(handlerOf, 'feedback.send', {
      token: sender.token,
      input: { message: 'Saved only', pagePath: '/' },
    })
    expect(result.error).toBeUndefined()
    expect(quiet.sent).toEqual([])
    expect(await stored(sender.user.id)).toHaveLength(1)
  })

  it('at most 10 an hour per person, counted in the database: RATE_LIMITED', async () => {
    const sender = await person()
    for (let i = 0; i < 10; i += 1) {
      expect((await send(sender.token, { message: `n${i}`, pagePath: '/' })).error).toBeUndefined()
    }
    expect(appCode(await send(sender.token, { message: 'more', pagePath: '/' }))).toBe(
      'rate_limited',
    )
    expect(await stored(sender.user.id)).toHaveLength(10)
  })

  it('at most 30 a day per person, hours apart', async () => {
    const sender = await person()
    // Earlier today: written past the trigger, which would count them and set their time.
    await admin`set session_replication_role = replica`
    for (let i = 0; i < 30; i += 1) {
      await admin`
        insert into app.feedback (id, user_id, page_path, message, created_at)
        values (${newId()}, ${sender.user.id}, '/', 'old', now() - interval '2 hours')`
    }
    await admin`set session_replication_role = default`
    expect(appCode(await send(sender.token, { message: 'more', pagePath: '/' }))).toBe(
      'rate_limited',
    )
  })

  describe('a picture', () => {
    async function uploadUrlFor(token: string, contentType = 'image/png') {
      const issued = await mutate<FeedbackImageUploadDto>(handler, 'feedback.imageUploadUrl', {
        token,
        input: { contentType },
      })
      expect(issued.error).toBeUndefined()
      return issued.data!
    }

    it('is saved with its message, and only a platform admin gets its link', async () => {
      const sender = await person()
      const target = await uploadUrlFor(sender.token)
      expect(target.path).toMatch(new RegExp(`^feedback/${sender.user.id}/`))
      expect((await uploadTo(target.uploadUrl, PNG, 'image/png')).status).toBe(200)
      const result = await send(sender.token, {
        message: 'With a picture',
        pagePath: '/',
        imagePath: target.path,
      })
      expect(result.error).toBeUndefined()
      expect((await stored(sender.user.id))[0]?.image_path).toBe(target.path)
      const [row] = await admin<{ status: string }[]>`
        select status from app.feedback_uploads where path = ${target.path}`
      expect(row?.status).toBe('used')
    })

    it('someone else’s picture, another folder or an unregistered path is refused', async () => {
      const victim = await person()
      const target = await uploadUrlFor(victim.token)
      await uploadTo(target.uploadUrl, PNG, 'image/png')
      const attacker = await person()
      for (const imagePath of [
        target.path,
        `feedback/${attacker.user.id}/../${victim.user.id}/x.png`,
        `feedback/${attacker.user.id}/${newId()}.png`,
        `${newId()}/logo/${newId()}.png`,
      ]) {
        const code = appCode(await send(attacker.token, { message: 'x', pagePath: '/', imagePath }))
        expect(['validation', 'attachment_invalid'], imagePath).toContain(code)
      }
      expect(await stored(attacker.user.id)).toEqual([])
    })

    it('goes on one feedback only, and Storage takes nothing more at its path', async () => {
      const sender = await person()
      const target = await uploadUrlFor(sender.token)
      await uploadTo(target.uploadUrl, PNG, 'image/png')
      const input = { message: 'once', pagePath: '/', imagePath: target.path }
      expect((await send(sender.token, input)).error).toBeUndefined()
      expect(appCode(await send(sender.token, input))).toBe('attachment_invalid')
      const again = await uploadTo(target.uploadUrl, PNG, 'image/png')
      expect(again.ok).toBe(false)
    })

    it('anything that is not really an image is refused and removed', async () => {
      const sender = await person()
      for (const [bytes, type] of [
        [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png'],
        [Buffer.from('%PDF-1.7 not a picture'), 'image/png'],
        [Buffer.concat([PNG.subarray(0, 12), Buffer.from('broken')]), 'image/png'],
      ] as const) {
        const target = await uploadUrlFor(sender.token)
        await uploadTo(target.uploadUrl, bytes, type)
        expect(
          appCode(
            await send(sender.token, {
              message: 'bad',
              pagePath: '/',
              imagePath: target.path,
            }),
          ),
        ).toBe('attachment_invalid')
        const [row] = await admin<{ status: string }[]>`
          select status from app.feedback_uploads where path = ${target.path}`
        expect(row?.status).toBe('discarded')
      }
      // A PNG sent as a JPEG: the name and the bytes disagree.
      const mismatched = await uploadUrlFor(sender.token, 'image/jpeg')
      await uploadTo(mismatched.uploadUrl, PNG, 'image/jpeg')
      expect(
        appCode(
          await send(sender.token, {
            message: 'bad',
            pagePath: '/',
            imagePath: mismatched.path,
          }),
        ),
      ).toBe('attachment_invalid')
      expect(await stored(sender.user.id)).toEqual([])
    })

    it('a refused send takes its picture: the same file is not checked again past the limit', async () => {
      const sender = await person()
      const victim = await person()
      const victimBusiness = await setupBusiness(handler, victim.token, WORKSHOP)
      const target = await uploadUrlFor(sender.token)
      await uploadTo(target.uploadUrl, PNG, 'image/png')
      const input = { message: 'x', pagePath: '/', imagePath: target.path }
      expect(appCode(await send(sender.token, input, victimBusiness))).toBe('forbidden')
      const [row] = await admin<{ status: string }[]>`
        select status from app.feedback_uploads where path = ${target.path}`
      expect(row?.status).toBe('discarded')
      expect(appCode(await send(sender.token, input))).toBe('attachment_invalid')
    })

    it('two sends of one picture at once: one is saved, and keeps its file', async () => {
      const sender = await person()
      const target = await uploadUrlFor(sender.token)
      await uploadTo(target.uploadUrl, PNG, 'image/png')
      const input = { message: 'at once', pagePath: '/', imagePath: target.path }
      const answers = await Promise.all([send(sender.token, input), send(sender.token, input)])
      expect(answers.filter((answer) => !answer.error)).toHaveLength(1)
      expect(answers.map((answer) => appCode(answer)).filter(Boolean)).toEqual([
        'attachment_invalid',
      ])
      const [row] = await admin<{ status: string }[]>`
        select status from app.feedback_uploads where path = ${target.path}`
      expect(row?.status).toBe('used')
      const [object] = await admin`
        select 1 from storage.objects
         where bucket_id = 'business-files' and name = ${target.path}`
      expect(object).toBeDefined()
    })

    it('other types are refused before any URL is issued', async () => {
      const sender = await person()
      for (const contentType of ['image/svg+xml', 'application/pdf', 'text/html']) {
        expect(
          appCode(
            await mutate(handler, 'feedback.imageUploadUrl', {
              token: sender.token,
              input: { contentType },
            }),
          ),
        ).toBe('validation')
      }
    })

    it('at most 10 upload URLs an hour per person: RATE_LIMITED', async () => {
      const sender = await person()
      for (let i = 0; i < 10; i += 1) await uploadUrlFor(sender.token)
      expect(
        appCode(
          await mutate(handler, 'feedback.imageUploadUrl', {
            token: sender.token,
            input: { contentType: 'image/png' },
          }),
        ),
      ).toBe('rate_limited')
    })
  })

  describe('reading it', () => {
    it('only through platform.feedback, with no more than it holds, and no name after deletion', async () => {
      const reader = await person({}, OWNER_EMAIL.replace('platform-owner', 'platform-list'))
      const handlerOf = handlerFor(
        db,
        undefined,
        { platformAdmins: [reader.user.email.toLowerCase()], supabaseSecretKey: SECRET_KEY },
        { emailSender: new Mailbox() },
      )
      const sender = await person()
      await query(handlerOf, 'me', { token: sender.token })
      const businessId = await setupBusiness(handlerOf, sender.token, WORKSHOP, {
        name: 'Listed Workshop',
      })
      const target = (
        await mutate<FeedbackImageUploadDto>(handlerOf, 'feedback.imageUploadUrl', {
          token: sender.token,
          input: { contentType: 'image/png' },
        })
      ).data!
      await uploadTo(target.uploadUrl, PNG, 'image/png')
      const sent = await mutate(handlerOf, 'feedback.send', {
        token: sender.token,
        businessId,
        input: { message: 'Read me', pagePath: PAGE, imagePath: target.path },
      })
      expect(sent.error).toBeUndefined()

      const page = await query<PlatformFeedbackDto>(handlerOf, 'platform.feedback', {
        token: reader.token,
        input: {},
      })
      const item = page.data?.items.find((entry) => entry.message === 'Read me')
      expect(item).toMatchObject({
        pagePath: PAGE,
        businessName: 'Listed Workshop',
        email: sender.user.email,
      })
      expect(item?.memberName).toBeTruthy()
      expect(item?.imageUrl).toContain('/storage/v1/object/sign/business-files/feedback/')
      expect(Object.keys(item!).sort()).toEqual(
        [
          'businessName',
          'createdAt',
          'email',
          'id',
          'imageUrl',
          'memberName',
          'message',
          'pagePath',
        ].sort(),
      )

      // The sender cannot read their own feedback back, not even as a member of that business.
      expect(
        appCode(
          await query(handlerOf, 'platform.feedback', {
            token: sender.token,
            businessId,
            input: {},
          }),
        ),
      ).toBe('forbidden')

      // The account is deleted: Auth's row goes and the name with it.
      await admin`update app.business_members set display_name = 'Deleted user', email = null
                   where user_id = ${sender.user.id}`
      await deleteUser(sender.user)
      const after = await query<PlatformFeedbackDto>(handlerOf, 'platform.feedback', {
        token: reader.token,
        input: {},
      })
      const kept = after.data?.items.find((entry) => entry.message === 'Read me')
      expect(kept?.email).toBeNull()
      expect(kept?.memberName).toBe('Deleted user')
    })

    it('pages newest first', async () => {
      const reader = await person({}, OWNER_EMAIL.replace('platform-owner', 'platform-pages'))
      const handlerOf = handlerFor(
        db,
        undefined,
        { platformAdmins: [reader.user.email.toLowerCase()] },
        { emailSender: new Mailbox() },
      )
      const first = await query<PlatformFeedbackDto>(handlerOf, 'platform.feedback', {
        token: reader.token,
        input: {},
      })
      const ids = first.data!.items.map((item) => item.id)
      expect([...ids].sort().reverse()).toEqual(ids)
      if (first.data!.nextCursor) {
        const next = await query<PlatformFeedbackDto>(handlerOf, 'platform.feedback', {
          token: reader.token,
          input: { cursor: first.data!.nextCursor },
        })
        expect(next.data!.items[0]!.id < ids.at(-1)!).toBe(true)
      }
    })
  })
})

describe('the terms: accepted once, with their version and time', () => {
  const termsOf = async (userId: string) => {
    const [row] = await admin<{ terms_version: string | null; terms_accepted_at: Date | null }[]>`
      select terms_version, terms_accepted_at from app.profiles where id = ${userId}`
    return row
  }

  it('the sign-up form’s box: the first `me` keeps the version and the time', async () => {
    const signedUp = await person({ locale: 'en', [LEGAL_METADATA_KEY]: LEGAL_VERSION })
    const me = await query<MeDto>(handler, 'me', { token: signedUp.token })
    expect(me.data?.profile.termsAccepted).toBe(true)
    const row = await termsOf(signedUp.user.id)
    expect(row?.terms_version).toBe(LEGAL_VERSION)
    expect(row?.terms_accepted_at).toBeInstanceOf(Date)
  })

  it('an account made another way ("send me a code"), or an older version: not accepted yet', async () => {
    const byCode = await person({ locale: 'en' })
    expect(
      (await query<MeDto>(handler, 'me', { token: byCode.token })).data?.profile,
    ).toMatchObject({ termsAccepted: false })
    const older = await person({ [LEGAL_METADATA_KEY]: '2020-01-01-old' })
    expect((await query<MeDto>(handler, 'me', { token: older.token })).data?.profile).toMatchObject(
      {
        termsAccepted: false,
      },
    )
    expect((await termsOf(older.user.id))?.terms_version).toBeNull()
  })

  it('account.acceptTerms: only the version in force, and the first time stays', async () => {
    const someone = await person()
    expect(
      appCode(
        await mutate(handler, 'account.acceptTerms', {
          token: someone.token,
          input: { termsVersion: '2020-01-01-old' },
        }),
      ),
    ).toBe('validation')
    const accepted = await mutate<ProfileDto>(handler, 'account.acceptTerms', {
      token: someone.token,
      input: { termsVersion: LEGAL_VERSION },
    })
    expect(accepted.data?.termsAccepted).toBe(true)
    const first = await termsOf(someone.user.id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await mutate(handler, 'account.acceptTerms', {
      token: someone.token,
      input: { termsVersion: LEGAL_VERSION },
    })
    expect((await termsOf(someone.user.id))?.terms_accepted_at).toEqual(first?.terms_accepted_at)
    expect(
      appCode(
        await mutate(handler, 'account.acceptTerms', {
          input: { termsVersion: LEGAL_VERSION },
          headers: FROM_APP,
        }),
      ),
    ).toBe('unauthorized')
  })

  it('accepting changes only the caller’s own row', async () => {
    const one = await person()
    const other = await person()
    await query(handler, 'me', { token: other.token })
    await mutate(handler, 'account.acceptTerms', {
      token: one.token,
      input: { termsVersion: LEGAL_VERSION, id: other.user.id },
    })
    expect((await termsOf(other.user.id))?.terms_version).toBeNull()
  })
})

describe('business.context on this deployment is not touched by the beta procedures', () => {
  it('no business procedure was added: feedback and platform are outside any business', async () => {
    const member = await person()
    const businessId = await setupBusiness(handler, member.token, WORKSHOP)
    const context = await query<BusinessContextDto>(handler, 'business.context', {
      token: member.token,
      businessId,
    })
    const paths = context.data!.modules.flatMap((m) => m.nav.map((entry) => entry.path))
    expect(paths.some((path) => path.includes('platform'))).toBe(false)
  })
})
