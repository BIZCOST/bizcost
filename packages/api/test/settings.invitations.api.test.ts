import { createHash } from 'node:crypto'
import type {
  AcceptInvitationDto,
  InvitationDto,
  InvitationPreviewDto,
  MeDto,
  MemberDto,
  RoleDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import {
  appCode,
  CapturedEmails,
  join,
  randomToken,
  setupBusiness,
  templateRoleId,
  WORKSHOP,
} from './settings'

// Invitations (ROADMAP.md Step 6, docs/ARCHITECTURE.md §Auth): create → email → preview → accept as a
// new user → member, plus resend/revoke, the database limits (20 a day per business, 3 resends, 30
// previews an hour), and the attacks: token guessing, replay, expired and revoked links, another email,
// an unverified email, other businesses. Emails are captured (one test goes through SMTP to Mailpit).

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

async function newUser(options: { email?: string; confirmed?: boolean } = {}): Promise<Person> {
  const user = await createUser({ locale: 'en' }, options)
  users.push(user)
  return { user, token: await mintToken(user) }
}

function inviteeEmail(): string {
  return `invitee-${newId()}@test.bizcost.local`
}

async function workshop(name = 'Nour Works') {
  const owner = await newUser()
  const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name })
  // The inviter's name co-members see.
  await admin`update app.business_members set display_name = 'Rashed' where business_id = ${businessId} and user_id = ${owner.user.id}`
  const employeeRole = await templateRoleId(db, owner.user, businessId, 'employee')
  return { owner, businessId, employeeRole }
}

function invite(
  token: string,
  businessId: string,
  input: { email: string; roleId: string; locale?: 'en' | 'ar'; id?: string },
) {
  return mutate<InvitationDto>(handler, 'invitation.create', {
    token,
    businessId,
    input: { id: input.id ?? newId(), locale: input.locale ?? 'en', ...input },
  })
}

function preview(token: string, auth?: string) {
  return query<InvitationPreviewDto>(handler, 'invitation.preview', {
    token: auth,
    input: { token },
  })
}

function accept(token: string, auth: string) {
  return mutate<AcceptInvitationDto>(handler, 'invitation.accept', {
    token: auth,
    input: { token },
  })
}

async function invitationRow(id: string) {
  const [row] = await admin<
    {
      token_hash: string
      status: string
      send_count: number
      expires_at: Date
      locale: string
      email: string
    }[]
  >`select token_hash, status, send_count, expires_at, locale, email::text
      from app.business_invitations where id = ${id}`
  return row
}

describe('invitation.create → email → preview → accept', () => {
  it('invites, emails a link, and the invitee joins with that email as a new user', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const email = inviteeEmail()
    const created = await invite(owner.token, businessId, {
      email: ` ${email.toUpperCase()} `,
      roleId: employeeRole,
    })
    expect(created.error).toBeUndefined()
    expect(created.data).toMatchObject({
      email,
      roleId: employeeRole,
      roleTemplateKey: 'employee',
      locale: 'en',
      status: 'pending',
      resendsLeft: 3,
    })

    // The email: one link, the business, the inviter; the token is stored only as its hash.
    const [message] = emails.to(email)
    expect(message?.subject).toBe('Rashed invited you to join Nour Works on BizCost')
    expect(message?.text).toContain(`${ORIGIN}/invite/`)
    const token = emails.tokenFor(email)
    expect(message?.html).toContain(`href="${ORIGIN}/invite/${token}"`)
    const row = await invitationRow(created.data!.id)
    expect(row?.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(row).toMatchObject({ status: 'pending', send_count: 1, locale: 'en' })
    const days = (row!.expires_at.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThanOrEqual(7)
    const audit = await admin<{ changes: string }[]>`
      select changes::text from app.audit_log where entity = 'business_invitations' and entity_id = ${created.data!.id}`
    expect(audit.length).toBeGreaterThan(0)
    for (const entry of audit) {
      expect(entry.changes).not.toContain(token)
      expect(entry.changes).not.toContain('token_hash')
    }

    // Signed out: the preview shows only the business, the inviter, the role and a masked email.
    const shown = await preview(token)
    expect(shown.error).toBeUndefined()
    expect(shown.data).toMatchObject({
      businessName: 'Nour Works',
      inviterName: 'Rashed',
      roleTemplateKey: 'employee',
      maskedEmail: `i•••@test.bizcost.local`,
      expired: false,
      emailMatches: null,
    })
    expect(JSON.stringify(shown.data)).not.toContain(email)

    // Signed in with another email: the page can say so before trying.
    const stranger = await newUser()
    expect((await preview(token, stranger.token)).data?.emailMatches).toBe(false)
    expect(appCode(await accept(token, stranger.token))).toBe('invitation_invalid')

    // The invitee creates an account with the invited email and accepts.
    const invitee = await newUser({ email })
    expect((await preview(token, invitee.token)).data?.emailMatches).toBe(true)
    const joined = await accept(token, invitee.token)
    expect(joined.error).toBeUndefined()
    expect(joined.data).toEqual({ businessId })

    const members = await query<MemberDto[]>(handler, 'member.list', {
      token: owner.token,
      businessId,
    })
    const member = members.data?.find((m) => m.email === email)
    expect(member).toMatchObject({ roleTemplateKey: 'employee', status: 'active', kind: 'account' })
    const me = await query<MeDto>(handler, 'me', { token: invitee.token })
    expect(me.data?.memberships.map((m) => m.businessId)).toContain(businessId)
    expect(me.data?.profile.lastBusinessId).toBe(businessId)
    expect((await invitationRow(created.data!.id))?.status).toBe('accepted')

    // Replay: the link is used up (same answer as an unknown token).
    expect(appCode(await accept(token, invitee.token))).toBe('invitation_invalid')
    expect(appCode(await preview(token))).toBe('invitation_invalid')
    const list = await query<InvitationDto[]>(handler, 'invitation.list', {
      token: owner.token,
      businessId,
    })
    expect(list.data?.map((i) => i.id)).not.toContain(created.data!.id)
  })

  it('writes the email in the chosen language (Arabic)', async () => {
    const { owner, businessId, employeeRole } = await workshop('ورشة نور')
    const email = inviteeEmail()
    await invite(owner.token, businessId, { email, roleId: employeeRole, locale: 'ar' })
    const [message] = emails.to(email)
    expect(message?.subject).toBe('دعوة من Rashed للانضمام إلى ورشة نور على BizCost')
    expect(message?.html).toContain('dir="rtl"')
    expect(message?.html).toContain('بدور «<bdi>الموظف</bdi>»')
  })

  it('escapes names in the HTML email', async () => {
    const { owner, businessId, employeeRole } = await workshop('<b>Bold</b> & Co')
    const email = inviteeEmail()
    await invite(owner.token, businessId, { email, roleId: employeeRole })
    const [message] = emails.to(email)
    expect(message?.html).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; Co')
    expect(message?.html).not.toContain('<b>Bold</b>')
  })
})

describe('accepting: every problem is the same INVITATION_INVALID', () => {
  it('refuses guessed, malformed, expired and revoked tokens, and an unverified email', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const someone = await newUser()
    for (const token of [randomToken(), randomToken(), 'short', `${randomToken()}x`, '']) {
      if (token === '') continue
      expect(appCode(await preview(token)), token).toBe('invitation_invalid')
      expect(appCode(await accept(token, someone.token)), token).toBe('invitation_invalid')
    }

    // Expired: shown as expired, cannot be accepted; a resend gives a new working link.
    const email = inviteeEmail()
    const created = await invite(owner.token, businessId, { email, roleId: employeeRole })
    const oldToken = emails.tokenFor(email)
    await admin`update app.business_invitations set expires_at = now() - interval '1 minute' where id = ${created.data!.id}`
    expect((await preview(oldToken)).data?.expired).toBe(true)
    const invitee = await newUser({ email })
    expect(appCode(await accept(oldToken, invitee.token))).toBe('invitation_invalid')
    const listed = await query<InvitationDto[]>(handler, 'invitation.list', {
      token: owner.token,
      businessId,
    })
    expect(listed.data?.find((i) => i.id === created.data!.id)?.status).toBe('expired')
    const resent = await mutate<InvitationDto>(handler, 'invitation.resend', {
      token: owner.token,
      businessId,
      input: { id: created.data!.id },
    })
    expect(resent.data).toMatchObject({ status: 'pending', resendsLeft: 2 })
    const newToken = emails.tokenFor(email)
    expect(newToken).not.toBe(oldToken)
    expect(appCode(await preview(oldToken))).toBe('invitation_invalid')
    expect((await accept(newToken, invitee.token)).data).toEqual({ businessId })

    // Revoked.
    const revokedEmail = inviteeEmail()
    const revoked = await invite(owner.token, businessId, {
      email: revokedEmail,
      roleId: employeeRole,
    })
    const revokedToken = emails.tokenFor(revokedEmail)
    const revoke = await mutate(handler, 'invitation.revoke', {
      token: owner.token,
      businessId,
      input: { id: revoked.data!.id },
    })
    expect(revoke.data).toEqual({ ok: true })
    const revokedInvitee = await newUser({ email: revokedEmail })
    expect(appCode(await preview(revokedToken))).toBe('invitation_invalid')
    expect(appCode(await accept(revokedToken, revokedInvitee.token))).toBe('invitation_invalid')
    expect(
      (
        await mutate(handler, 'invitation.revoke', {
          token: owner.token,
          businessId,
          input: { id: revoked.data!.id },
        })
      ).data,
    ).toEqual({ ok: true })

    // The right email, not verified yet.
    const unverifiedEmail = inviteeEmail()
    await invite(owner.token, businessId, { email: unverifiedEmail, roleId: employeeRole })
    const unverified = await newUser({ email: unverifiedEmail, confirmed: false })
    const unverifiedToken = emails.tokenFor(unverifiedEmail)
    expect(appCode(await accept(unverifiedToken, unverified.token))).toBe('invitation_invalid')
    expect((await preview(unverifiedToken, unverified.token)).data?.emailMatches).toBe(false)
  })

  it('an already active member gets ALREADY_MEMBER; a removed member can come back', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const email = inviteeEmail()
    const member = await newUser({ email })
    const memberId = await join(db, owner.user, businessId, member.user, 'employee')
    expect(appCode(await invite(owner.token, businessId, { email, roleId: employeeRole }))).toBe(
      'already_member',
    )
    // Pending invitation made before they joined another way: accepting says already a member.
    await admin`update app.business_members set status = 'removed' where id = ${memberId}`
    await invite(owner.token, businessId, { email, roleId: employeeRole })
    const token = emails.tokenFor(email)
    await admin`update app.business_members set status = 'active' where id = ${memberId}`
    expect(appCode(await accept(token, member.token))).toBe('already_member')
    await admin`update app.business_members set status = 'removed' where id = ${memberId}`
    expect((await accept(token, member.token)).data).toEqual({ businessId })
    const [row] = await admin<{ status: string; email: string }[]>`
      select status, email::text from app.business_members where id = ${memberId}`
    expect(row).toEqual({ status: 'active', email })
  })
})

describe('invitation.create rules', () => {
  it('is idempotent on the id; the same email twice is ALREADY_INVITED', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const email = inviteeEmail()
    const id = newId()
    const first = await invite(owner.token, businessId, { id, email, roleId: employeeRole })
    const retry = await invite(owner.token, businessId, { id, email, roleId: employeeRole })
    expect(retry.data?.id).toBe(first.data?.id)
    expect(emails.to(email)).toHaveLength(1)
    const salesRole = await templateRoleId(db, owner.user, businessId, 'sales')
    expect(appCode(await invite(owner.token, businessId, { id, email, roleId: salesRole }))).toBe(
      'conflict',
    )
    expect(appCode(await invite(owner.token, businessId, { email, roleId: employeeRole }))).toBe(
      'already_invited',
    )
  })

  it('never invites as Owner, with another business’s role, or with more access than the inviter', async () => {
    const { owner, businessId } = await workshop()
    const ownerRole = await templateRoleId(db, owner.user, businessId, 'owner')
    expect(
      appCode(await invite(owner.token, businessId, { email: inviteeEmail(), roleId: ownerRole })),
    ).toBe('owner_transfer_required')
    const other = await workshop()
    expect(
      appCode(
        await invite(owner.token, businessId, {
          email: inviteeEmail(),
          roleId: other.employeeRole,
        }),
      ),
    ).toBe('not_found')

    // A manager who may manage the team cannot invite an Admin.
    const managerRole = await templateRoleId(db, owner.user, businessId, 'manager')
    const roles = (await query<RoleDto[]>(handler, 'role.list', { token: owner.token, businessId }))
      .data!
    const manager = roles.find((r) => r.id === managerRole)!
    await mutate(handler, 'role.updatePermissions', {
      token: owner.token,
      businessId,
      input: {
        id: managerRole,
        version: manager.version,
        permissionKeys: [...manager.permissionKeys, 'settings.members.manage'],
      },
    })
    const lead = await newUser()
    await join(db, owner.user, businessId, lead.user, 'manager')
    const adminRole = await templateRoleId(db, owner.user, businessId, 'admin')
    const salesRole = await templateRoleId(db, owner.user, businessId, 'sales')
    expect(
      appCode(await invite(lead.token, businessId, { email: inviteeEmail(), roleId: adminRole })),
    ).toBe('forbidden')
    expect(
      (await invite(lead.token, businessId, { email: inviteeEmail(), roleId: salesRole })).error,
    ).toBeUndefined()
  })

  it('cancels the invitation when its email cannot be sent (sent after the commit)', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const id = newId()
    const email = inviteeEmail()
    emails.failNext = true
    const result = await invite(owner.token, businessId, { id, email, roleId: employeeRole })
    expect(appCode(result)).toBe('internal')
    // Nobody got its link: it is revoked (and still counts toward the limits).
    expect((await invitationRow(id))?.status).toBe('revoked')
    // The same id is used up; a new try (new id) invites the address.
    expect(
      appCode(await invite(owner.token, businessId, { id, email, roleId: employeeRole })),
    ).toBe('conflict')
    const again = await invite(owner.token, businessId, { email, roleId: employeeRole })
    expect(again.error).toBeUndefined()
    expect(emails.to(email)).toHaveLength(1)
  })

  it('is for settings.members.manage (owner, admin); the list for settings.members.view', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const created = await invite(owner.token, businessId, {
      email: inviteeEmail(),
      roleId: employeeRole,
    })
    for (const [template, canList, canManage] of [
      ['admin', true, true],
      ['manager', true, false],
      ['supervisor', true, false],
      ['accountant', false, false],
      ['sales', false, false],
      ['employee', false, false],
    ] as const) {
      const member = await newUser()
      await join(db, owner.user, businessId, member.user, template)
      const list = await query(handler, 'invitation.list', { token: member.token, businessId })
      expect(list.error?.data.appCode, `${template} list`).toBe(canList ? undefined : 'forbidden')
      const create = await invite(member.token, businessId, {
        email: inviteeEmail(),
        roleId: employeeRole,
      })
      expect(create.error?.data.appCode, `${template} create`).toBe(
        canManage ? undefined : 'forbidden',
      )
      if (!canManage) {
        for (const path of ['invitation.resend', 'invitation.revoke']) {
          const write = await mutate(handler, path, {
            token: member.token,
            businessId,
            input: { id: created.data!.id },
          })
          expect(write.error?.data.appCode, `${template} ${path}`).toBe('forbidden')
        }
      }
    }
  })

  it('cannot see, resend or revoke another business’s invitations', async () => {
    const a = await workshop()
    const b = await workshop()
    const invitationB = await invite(b.owner.token, b.businessId, {
      email: inviteeEmail(),
      roleId: b.employeeRole,
    })
    for (const path of ['invitation.resend', 'invitation.revoke']) {
      const attack = await mutate(handler, path, {
        token: a.owner.token,
        businessId: a.businessId,
        input: { id: invitationB.data!.id },
      })
      expect(appCode(attack), path).toBe('not_found')
    }
    const list = await query<InvitationDto[]>(handler, 'invitation.list', {
      token: a.owner.token,
      businessId: a.businessId,
    })
    expect(list.data).toEqual([])
    expect((await invitationRow(invitationB.data!.id))?.status).toBe('pending')
  })
})

describe('limits counted in the database', () => {
  it('20 invitations a day per business, then RATE_LIMITED', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    for (let i = 0; i < 20; i++) {
      const result = await invite(owner.token, businessId, {
        email: inviteeEmail(),
        roleId: employeeRole,
      })
      expect(result.error, `invitation ${i + 1}`).toBeUndefined()
    }
    const over = await invite(owner.token, businessId, {
      email: inviteeEmail(),
      roleId: employeeRole,
    })
    expect(appCode(over)).toBe('rate_limited')
    expect(over.status).toBe(429)
  })

  it('3 resends per invitation, then RATE_LIMITED', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const email = inviteeEmail()
    const created = await invite(owner.token, businessId, { email, roleId: employeeRole })
    const resend = () =>
      mutate<InvitationDto>(handler, 'invitation.resend', {
        token: owner.token,
        businessId,
        input: { id: created.data!.id },
      })
    for (const left of [2, 1, 0]) expect((await resend()).data?.resendsLeft).toBe(left)
    expect(appCode(await resend())).toBe('rate_limited')
    expect(emails.to(email)).toHaveLength(4)
    expect((await invitationRow(created.data!.id))?.send_count).toBe(4)
  })

  it('30 previews of one invitation an hour, then RATE_LIMITED', async () => {
    const { owner, businessId, employeeRole } = await workshop()
    const email = inviteeEmail()
    await invite(owner.token, businessId, { email, roleId: employeeRole })
    const token = emails.tokenFor(email)
    for (let i = 0; i < 30; i++)
      expect((await preview(token)).error, `preview ${i + 1}`).toBeUndefined()
    expect(appCode(await preview(token))).toBe('rate_limited')
  })
})

describe('email through SMTP (Mailpit)', () => {
  it('sends the invitation to the local Mailpit', async () => {
    const smtpHandler = handlerFor(db, undefined, {
      supabaseSecretKey: SECRET_KEY,
      email: {
        transport: 'smtp',
        host: '127.0.0.1',
        port: 54325,
        from: 'BizCost <no-reply@bizcost.local>',
      },
    })
    const { owner, businessId, employeeRole } = await workshop('Mail Works')
    const email = inviteeEmail()
    const created = await mutate<InvitationDto>(smtpHandler, 'invitation.create', {
      token: owner.token,
      businessId,
      input: { id: newId(), email, roleId: employeeRole, locale: 'en' },
    })
    expect(created.error).toBeUndefined()
    const mailpit = process.env.SUPABASE_MAILPIT_URL ?? 'http://127.0.0.1:54324'
    let text: string | undefined
    for (let i = 0; i < 50 && !text; i++) {
      const search = (await (
        await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
      ).json()) as { messages: { ID: string; Subject: string }[] }
      const message = search.messages[0]
      if (message) {
        expect(message.Subject).toBe('Rashed invited you to join Mail Works on BizCost')
        const detail = (await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json()) as {
          Text: string
        }
        text = detail.Text
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(text ?? '')?.[1]
    expect(token).toBeDefined()
    expect((await preview(token!)).data?.businessName).toBe('Mail Works')
  })
})
