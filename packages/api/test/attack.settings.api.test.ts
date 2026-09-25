import type {
  BusinessProfileDto,
  InvitationDto,
  LogoUploadUrlDto,
  RoleDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EmailSender } from '../src'
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
  type Admin,
  type TestUser,
} from './helpers'
import { appCode, CapturedEmails, join, setupBusiness, templateRoleId, WORKSHOP } from './settings'

// Attacker pass on Step 6 (web settings). Each test proved a real issue of the first Step 6 build and
// names the safe behaviour, which the fixes now give (D-082 invitations follow their sender and have
// per-address limits; D-084 role edits stay within the editor's access; D-085 the upload registry;
// D-081 emails are sent outside transactions).

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

function call<T = unknown>(token: string, businessId: string, path: string, input?: unknown) {
  return input === undefined
    ? query<T>(handler, path, { token, businessId })
    : mutate<T>(handler, path, { token, businessId, input })
}

async function roleByTemplate(token: string, businessId: string, template: string) {
  const roles = await call<RoleDto[]>(token, businessId, 'role.list')
  const role = roles.data?.find((r) => r.templateKey === template)
  if (!role) throw new Error(`no ${template} role`)
  return role
}

/** The owner adds `key` to the Manager role (an owner may hand any permission to any role). */
async function giveManagers(owner: Person, businessId: string, key: string) {
  const manager = await roleByTemplate(owner.token, businessId, 'manager')
  const result = await call(owner.token, businessId, 'role.updatePermissions', {
    id: manager.id,
    version: manager.version,
    permissionKeys: [...manager.permissionKeys, key],
  })
  expect(result.error).toBeUndefined()
}

async function inviteAs(token: string, businessId: string, email: string, roleId: string) {
  const result = await call<InvitationDto>(token, businessId, 'invitation.create', {
    id: newId(),
    email,
    roleId,
    locale: 'en',
  })
  expect(result.error).toBeUndefined()
  return result.data!
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const NOT_AN_IMAGE = Buffer.from('<html><script>alert(document.domain)</script></html>')

function put(url: string, bytes: Buffer, contentType: string) {
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(10_000),
  })
}

describe('ATTACK: a removed (or demoted) member keeps a way back through their own invitations', () => {
  it('an Admin invites a second address they own as Admin, is removed, and joins again as Admin', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const rogue = await newUser()
    const rogueMemberId = await join(db, owner.user, businessId, rogue.user, 'admin')
    const rogueAlt = await newUser()
    const adminRole = await templateRoleId(db, owner.user, businessId, 'admin')

    await inviteAs(rogue.token, businessId, rogueAlt.user.email, adminRole)
    const token = emails.tokenFor(rogueAlt.user.email)

    // The owner removes the Admin: "access revoked on the next request".
    const removed = await call(owner.token, businessId, 'member.remove', {
      memberId: rogueMemberId,
    })
    expect(removed.error).toBeUndefined()

    // The invitation the removed Admin created must not let them back in.
    const accepted = await mutate<{ businessId: string }>(handler, 'invitation.accept', {
      token: rogueAlt.token,
      input: { token },
    })
    expect(appCode(accepted)).toBe('invitation_invalid')
    const [back] = await admin<{ template_key: string | null }[]>`
      select r.template_key from app.business_members m
      join app.roles r on r.id = m.role_id
      where m.business_id = ${businessId} and m.user_id = ${rogueAlt.user.id}
        and m.status = 'active'`
    expect(back).toBeUndefined()
  })

  it('an Admin demoted to Employee still has a working Admin invitation they sent earlier', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const rogue = await newUser()
    const rogueMemberId = await join(db, owner.user, businessId, rogue.user, 'admin')
    const rogueAlt = await newUser()
    const adminRole = await templateRoleId(db, owner.user, businessId, 'admin')
    const employeeRole = await templateRoleId(db, owner.user, businessId, 'employee')

    await inviteAs(rogue.token, businessId, rogueAlt.user.email, adminRole)
    const token = emails.tokenFor(rogueAlt.user.email)
    const demoted = await call(owner.token, businessId, 'member.changeRole', {
      memberId: rogueMemberId,
      roleId: employeeRole,
    })
    expect(demoted.error).toBeUndefined()

    // The demoted member could no longer send this invitation (FORBIDDEN on create/resend), so the
    // one they already sent should not grant Admin either.
    const accepted = await mutate(handler, 'invitation.accept', {
      token: rogueAlt.token,
      input: { token },
    })
    expect(appCode(accepted)).toBe('invitation_invalid')
  })
})

describe('ATTACK: role editing takes away access beyond the editor’s own', () => {
  it('a Manager allowed to manage roles strips the Admin role, and the Admins cannot undo it', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    await giveManagers(owner, businessId, 'settings.roles.manage')
    const lead = await newUser()
    await join(db, owner.user, businessId, lead.user, 'manager')
    const anAdmin = await newUser()
    await join(db, owner.user, businessId, anAdmin.user, 'admin')
    const adminRole = await roleByTemplate(owner.token, businessId, 'admin')

    // The same Manager may not change an Admin's role nor remove an Admin (settings.team tests:
    // "cannot grant or take away more than their own access"). Editing the Admin ROLE must follow
    // the same rule: the Admin role grants more than the Manager holds.
    const stripped = await call<RoleDto>(lead.token, businessId, 'role.updatePermissions', {
      id: adminRole.id,
      version: adminRole.version,
      permissionKeys: adminRole.permissionKeys.filter(
        (key) =>
          !['settings.roles.manage', 'settings.members.view', 'data.cost.view'].includes(key),
      ),
    })
    expect(appCode(stripped)).toBe('forbidden')

    // What happens today: every Admin lost settings.roles.manage and cannot put it back.
    const after = await roleByTemplate(owner.token, businessId, 'admin')
    const restore = await call(anAdmin.token, businessId, 'role.updatePermissions', {
      id: after.id,
      version: after.version,
      permissionKeys: adminRole.permissionKeys,
    })
    expect(restore.error).toBeUndefined()
  })
})

describe('ATTACK: invitation.revoke ignores "not beyond your own access"', () => {
  it('a Manager allowed to manage the team cancels the owner’s Admin invitation (resend is refused)', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    await giveManagers(owner, businessId, 'settings.members.manage')
    const lead = await newUser()
    await join(db, owner.user, businessId, lead.user, 'manager')
    const adminRole = await templateRoleId(db, owner.user, businessId, 'admin')
    const invitation = await inviteAs(
      owner.token,
      businessId,
      `boss-${newId()}@test.bizcost.local`,
      adminRole,
    )

    expect(
      appCode(await call(lead.token, businessId, 'invitation.resend', { id: invitation.id })),
    ).toBe('forbidden')
    expect(
      appCode(await call(lead.token, businessId, 'invitation.revoke', { id: invitation.id })),
    ).toBe('forbidden')
    const [row] = await admin<{ status: string }[]>`
      select status from app.business_invitations where id = ${invitation.id}`
    expect(row?.status).toBe('pending')
  })
})

describe('ATTACK: the invitation email is sent inside the database transaction', () => {
  it('a slow email provider stalls an unrelated user’s request (the only pooled connection is held)', async () => {
    // The deployed API has ONE connection per instance (createDb default max: 1, like connectApi()).
    const SEND_MS = 2_000
    const slow: EmailSender = {
      send: () => new Promise<void>((resolve) => setTimeout(resolve, SEND_MS)),
    }
    const slowHandler = handlerFor(
      db,
      undefined,
      { supabaseSecretKey: SECRET_KEY },
      { emailSender: slow },
    )
    const attacker = await newUser()
    const businessId = await setupBusiness(slowHandler, attacker.token, WORKSHOP)
    const role = await templateRoleId(db, attacker.user, businessId, 'employee')
    const bystander = await newUser()

    const sending = mutate(slowHandler, 'invitation.create', {
      token: attacker.token,
      businessId,
      input: { id: newId(), email: `v-${newId()}@test.bizcost.local`, roleId: role, locale: 'en' },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const started = Date.now()
    const me = await query(slowHandler, 'me', { token: bystander.token })
    const waited = Date.now() - started
    await sending
    expect(me.status).toBe(200)
    // Another tenant's `me` must not wait for someone else's email provider.
    expect(waited).toBeLessThan(SEND_MS / 2)
  })
})

describe('ATTACK: logo upload URLs (unbounded, and reusable after the logo is removed)', () => {
  it('an old signed upload URL re-creates a removed logo, and the old download URL serves it unchecked', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const issued = await call<LogoUploadUrlDto>(owner.token, businessId, 'business.logoUploadUrl', {
      contentType: 'image/png',
    })
    const first = await put(issued.data!.uploadUrl, PNG, 'image/png')
    await first.arrayBuffer()
    expect(first.ok).toBe(true)
    const saved = await call<BusinessProfileDto>(owner.token, businessId, 'business.setLogo', {
      path: issued.data!.path,
    })
    const oldDownloadUrl = saved.data!.logoUrl!
    const removed = await mutate(handler, 'business.removeLogo', { token: owner.token, businessId })
    expect(removed.error).toBeUndefined()

    // Anyone who kept the upload URL (e.g. a member since removed) writes to the path again: bytes
    // setLogo never checked, which the earlier signed download URL serves again.
    const again = await put(issued.data!.uploadUrl, NOT_AN_IMAGE, 'image/png')
    await again.arrayBuffer()
    expect(again.ok).toBe(false)
    const served = await fetch(oldDownloadUrl, { signal: AbortSignal.timeout(10_000) })
    await served.arrayBuffer()
    expect(served.ok).toBe(false)
  })

  it('issues any number of upload URLs (each a 2 MB object nobody ever cleans up)', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const codes: (string | undefined)[] = []
    for (let i = 0; i < 40; i++) {
      const result = await call(owner.token, businessId, 'business.logoUploadUrl', {
        contentType: 'image/png',
      })
      codes.push(appCode(result))
    }
    // A logo is changed a few times, not 40 times in a few seconds: expect a limit.
    expect(codes).toContain('rate_limited')
  })
})

describe('ATTACK: invitation emails to one address are only limited per invitation', () => {
  it('cancel + invite again resets the resend budget: one address gets 8 emails from one business', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const role = await templateRoleId(db, owner.user, businessId, 'employee')
    const victim = `victim-${newId()}@test.bizcost.local`
    for (let round = 0; round < 2; round++) {
      const created = await call<InvitationDto>(owner.token, businessId, 'invitation.create', {
        id: newId(),
        email: victim,
        roleId: role,
        locale: 'en',
      })
      if (!created.data) break
      for (let i = 0; i < 3; i++) {
        await call(owner.token, businessId, 'invitation.resend', { id: created.data.id })
      }
      await call(owner.token, businessId, 'invitation.revoke', { id: created.data.id })
    }
    // Today: 8 emails here, up to 80 a day per business (20 invitations × 4 sends) and 800 a day
    // from one account (10 businesses a day), with a business name and inviter name the attacker
    // chose. Expect a per-address cap (e.g. 4 sends a day per business).
    expect(emails.to(victim).length).toBeLessThanOrEqual(4)
  })
})
