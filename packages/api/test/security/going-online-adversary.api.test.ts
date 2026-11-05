import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startHookedAuth, type HookedAuth } from '@bizcost/config/testing/hooked-auth'
import type { BetaEntryDto, FeedbackImageUploadDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EmailMessage, EmailSender } from '../../src'
import { printableImageType } from '../../src/services/document-files'
import {
  PICTURE_CHECKS_PER_PERSON,
  withPictureCheckSlot,
} from '../../src/services/picture-check-slot'
import { PNG, uploadTo } from '../hardening/fixture'
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
} from '../helpers'
import { appCode, setupBusiness, templateRoleId, WORKSHOP } from '../settings'

// The security adversary's review of going online (the closed beta, D-350). The tests the review wrote
// failed on the code they were written against, and hold since D-361 and D-362; the controls beside them
// say what the fixes must not take away. What the review tried and could not break (address variants, the Auth endpoints, a forged, unconfirmed or changed admin address,
// stored XSS, a picture swapped after its check, held modules' procedures) is in beta.api.test.ts and
// beta-held.api.test.ts, or was only probed.

const db = connectApi()
let admin: Admin
let auth: HookedAuth
const users: TestUser[] = []
const addresses = new Set<string>()

class SilentMailbox implements EmailSender {
  send(_message: EmailMessage): Promise<void> {
    return Promise.resolve()
  }
}

const ADMIN_EMAIL = `online-admin-${newId()}@test.bizcost.local`
const handler = handlerFor(
  db,
  undefined,
  { supabaseSecretKey: SECRET_KEY, platformAdmins: [ADMIN_EMAIL] },
  { emailSender: new SilentMailbox() },
)

/** A new address; letters only, as the other Auth tests. */
function address(label: string): string {
  const letters = randomUUID()
    .replace(/-/g, '')
    .slice(0, 12)
    .replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)))
  const email = `online-${label}-${letters}@test.bizcost.local`
  addresses.add(email)
  return email
}

async function person(email?: string) {
  const user = await createUser({ locale: 'en' }, email ? { email } : {})
  users.push(user)
  return { user, token: await mintToken(user) }
}

let adminToken: string | undefined
/** The one account with the platform admin's address. */
async function platformAdminToken() {
  adminToken ??= (await person(ADMIN_EMAIL)).token
  return adminToken
}

async function authCall(path: string, body: object) {
  const response = await fetch(`${auth.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const signUp = (email: string) => authCall('/signup', { email, password: 'abcdefg1' })
const askForCode = (email: string) => authCall('/otp', { email, create_user: true })

/** Auth emails an address at most once in a while: the next request comes later. */
const timePasses = (email: string) =>
  admin`update auth.users
           set confirmation_sent_at = confirmation_sent_at - interval '61 seconds'
         where email = ${email}`

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

describe('closed sign-up: a door closed after someone stepped into it', () => {
  // The hook runs only when Auth creates the row. A sign-up that was started and never confirmed is a
  // row, so the address needs neither the list nor the invitation any more: "Send me a code" goes
  // through and the code makes a full account, which can then create a business of its own. The owner
  // sees nothing of this on /platform. D-355 accepts "an account already made stays"; this one was not
  // made, and neither the runbook nor the invitation's revoke says so.
  const REFUSED = { status: 403, message: 'beta_invite_only' }

  it('an address taken off the list cannot finish a sign-up it only started', async () => {
    const token = await platformAdminToken()
    const email = address('removed')
    const added = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token,
      input: { email },
    })
    expect(added.error).toBeUndefined()
    expect((await signUp(email)).status).toBe(200)

    const removed = await mutate(handler, 'platform.betaRemove', {
      token,
      input: { id: added.data!.id },
    })
    expect(removed.error).toBeUndefined()

    await timePasses(email)
    const answer = await askForCode(email)
    expect({ status: answer.status, message: answer.body.msg }).toEqual(REFUSED)
  })

  it('a revoked invitation cannot be finished through a sign-up it started', async () => {
    const owner = await person()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const roleId = await templateRoleId(db, owner.user, businessId, 'employee')
    const email = address('revoked')
    const id = newId()
    const made = await mutate(handler, 'invitation.create', {
      token: owner.token,
      businessId,
      input: { id, email, roleId, locale: 'en' },
    })
    expect(made.error).toBeUndefined()
    expect((await signUp(email)).status).toBe(200)

    const revoked = await mutate(handler, 'invitation.revoke', {
      token: owner.token,
      businessId,
      input: { id },
    })
    expect(revoked.error).toBeUndefined()

    await timePasses(email)
    const answer = await askForCode(email)
    expect({ status: answer.status, message: answer.body.msg }).toEqual(REFUSED)
  })

  it('the same when the person who sent the invitation leaves the business', async () => {
    const owner = await person()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const roleId = await templateRoleId(db, owner.user, businessId, 'employee')
    const email = address('leaving')
    const made = await mutate(handler, 'invitation.create', {
      token: owner.token,
      businessId,
      input: { id: newId(), email, roleId, locale: 'en' },
    })
    expect(made.error).toBeUndefined()
    expect((await signUp(email)).status).toBe(200)

    // What invitations go through when their sender is removed or leaves.
    await admin`update app.business_invitations set status = 'revoked' where email = ${email}`

    await timePasses(email)
    const answer = await askForCode(email)
    expect({ status: answer.status, message: answer.body.msg }).toEqual(REFUSED)
  })

  it('still allowed another way, a sign-up already started stays and can finish', async () => {
    const token = await platformAdminToken()
    const owner = await person()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const roleId = await templateRoleId(db, owner.user, businessId, 'employee')
    const email = address('both')
    const listed = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token,
      input: { email },
    })
    const invitationId = newId()
    await mutate(handler, 'invitation.create', {
      token: owner.token,
      businessId,
      input: { id: invitationId, email, roleId, locale: 'en' },
    })
    expect((await signUp(email)).status).toBe(200)

    await mutate(handler, 'platform.betaRemove', { token, input: { id: listed.data!.id } })
    await timePasses(email)
    expect((await askForCode(email)).status).toBe(200)

    // The invitation was what still allowed it; once that goes too, so does the sign-up.
    await mutate(handler, 'invitation.revoke', {
      token: owner.token,
      businessId,
      input: { id: invitationId },
    })
    const [left] = await admin`select 1 as one from auth.users where email = ${email}`
    expect(left).toBeUndefined()
  })

  it('an account already confirmed stays when its address comes off the list (D-355)', async () => {
    const token = await platformAdminToken()
    const email = address('confirmed')
    const listed = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token,
      input: { email },
    })
    const { user } = await person(email)
    await mutate(handler, 'platform.betaRemove', { token, input: { id: listed.data!.id } })
    const [row] = await admin<{ id: string }[]>`select id from auth.users where email = ${email}`
    expect(row?.id).toBe(user.id)
  })

  it('and someone else’s started sign-up is not touched', async () => {
    const token = await platformAdminToken()
    const email = address('removed')
    const other = address('other')
    const added = await mutate<BetaEntryDto>(handler, 'platform.betaAdd', {
      token,
      input: { email },
    })
    await mutate<BetaEntryDto>(handler, 'platform.betaAdd', { token, input: { email: other } })
    expect((await signUp(other)).status).toBe(200)
    await mutate(handler, 'platform.betaRemove', { token, input: { id: added.data!.id } })
    const [row] = await admin`select 1 as one from auth.users where email = ${other}`
    expect(row).toBeDefined()
  })
})

describe('Send feedback: one person cannot crowd out everyone else', () => {
  // `checkedPicture` reads the status, downloads the object and queues it for the PDF compiler, all
  // before anything closes the upload or counts against a limit. So one upload URL, sent many times at
  // once, fills the engine's queue of 24 (PDF_MAX_QUEUED), and while it is full every other business's
  // picture check and PDF on that instance answers RATE_LIMITED (measured with a 6.8 MB picture: 40
  // sends kept it busy for seconds, and another caller's check was refused). Only the first send can
  // ever succeed, so a burst should end at the upload's status, before the download and the queue.
  it('a burst of sends of one picture does not make another caller’s picture check busy', async () => {
    const attacker = await person()
    const issued = await mutate<FeedbackImageUploadDto>(handler, 'feedback.imageUploadUrl', {
      token: attacker.token,
      input: { contentType: 'image/png' },
    })
    expect(issued.error).toBeUndefined()
    expect((await uploadTo(issued.data!.uploadUrl, PNG, 'image/png')).status).toBe(200)

    let settled = false
    const burst = Promise.all(
      Array.from({ length: 100 }, () =>
        mutate(handler, 'feedback.send', {
          token: attacker.token,
          input: { message: 'burst', pagePath: '/', imagePath: issued.data!.path },
        }),
      ),
    ).finally(() => {
      settled = true
    })

    // What another business's logo, signature or line picture goes through while this runs.
    const othersRefused: string[] = []
    while (!settled) {
      await printableImageType(PNG).catch((error: unknown) => {
        othersRefused.push(String((error as { code?: unknown }).code ?? error))
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const answers = await burst
    const busy = answers.filter((answer) => answer.error && appCode(answer) === 'rate_limited')
    expect({ othersRefused: othersRefused.length, burstBusy: busy.length }).toEqual({
      othersRefused: 0,
      burstBusy: 0,
    })
    expect(answers.filter((answer) => !answer.error)).toHaveLength(1)
  }, 120_000)

  /** One person's upload of each picture route, ready to send, and its call. */
  async function pictureRoutes() {
    const owner = await person()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const scoped = { token: owner.token, businessId }
    const logo = await mutate<{ path: string; uploadUrl: string }>(
      handler,
      'business.logoUploadUrl',
      {
        ...scoped,
        input: { contentType: 'image/png' },
      },
    )
    const signature = await mutate<{ path: string; uploadUrl: string }>(
      handler,
      'document.imageUploadUrl',
      { ...scoped, input: { kind: 'signature', contentType: 'image/png' } },
    )
    const customer = await mutate<{ id: string }>(handler, 'customer.create', {
      ...scoped,
      input: { id: newId(), name: 'A customer', kind: 'business' },
    })
    const locations = await query<{ id: string; isDefault: boolean }[]>(
      handler,
      'location.list',
      scoped,
    )
    const lineId = newId()
    const quotation = await mutate<{ id: string }>(handler, 'quotation.create', {
      ...scoped,
      input: {
        id: newId(),
        customerId: customer.data!.id,
        businessDate: new Date().toISOString().slice(0, 10),
        locationId: locations.data!.find((location) => location.isDefault)!.id,
        lines: [{ id: lineId, description: 'A line', qty: '1', unitPrice: '10' }],
      },
    })
    expect(quotation.error).toBeUndefined()
    const line = { entity: 'quotation_line', entityId: lineId }
    const picture = await mutate<{ path: string; uploadUrl: string }>(
      handler,
      'attachment.uploadUrl',
      { ...scoped, input: { ...line, contentType: 'image/png' } },
    )
    for (const upload of [logo, signature, picture]) {
      expect(upload.error).toBeUndefined()
      expect((await uploadTo(upload.data!.uploadUrl, PNG, 'image/png')).status).toBe(200)
    }
    return {
      owner,
      routes: {
        logo: () =>
          mutate(handler, 'business.setLogo', { ...scoped, input: { path: logo.data!.path } }),
        signature: () =>
          mutate(handler, 'document.setImage', {
            ...scoped,
            input: { kind: 'signature', path: signature.data!.path },
          }),
        picture: () =>
          mutate(handler, 'attachment.add', {
            ...scoped,
            input: { ...line, path: picture.data!.path, fileName: 'p.png' },
          }),
      },
    }
  }

  it('every route that checks a picture counts against the person’s share, and then goes through', async () => {
    const { owner, routes } = await pictureRoutes()
    const issued = await mutate<FeedbackImageUploadDto>(handler, 'feedback.imageUploadUrl', {
      token: owner.token,
      input: { contentType: 'image/png' },
    })
    await uploadTo(issued.data!.uploadUrl, PNG, 'image/png')
    const sendFeedback = () =>
      mutate(handler, 'feedback.send', {
        token: owner.token,
        input: { message: 'share', pagePath: '/', imagePath: issued.data!.path },
      })

    let finish: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    const slots = Array.from({ length: PICTURE_CHECKS_PER_PERSON }, () =>
      withPictureCheckSlot(owner.user.id, () => held),
    )
    for (const route of [routes.logo, routes.signature, routes.picture, sendFeedback]) {
      expect(appCode(await route())).toBe('rate_limited')
    }
    // Stopped for a reason of the server's: the feedback's upload is open again, not lost.
    const [row] = await admin<{ status: string }[]>`
      select status from app.feedback_uploads where path = ${issued.data!.path}`
    expect(row?.status).toBe('issued')

    finish()
    await Promise.all(slots)
    for (const route of [routes.logo, routes.signature, routes.picture, sendFeedback]) {
      expect((await route()).error).toBeUndefined()
    }
  })

  it('while a send holds an upload, Storage takes nothing at its path', async () => {
    const { token } = await person()
    const issued = await mutate<FeedbackImageUploadDto>(handler, 'feedback.imageUploadUrl', {
      token,
      input: { contentType: 'image/png' },
    })
    await admin`update app.feedback_uploads set status = 'checking' where path = ${issued.data!.path}`
    expect((await uploadTo(issued.data!.uploadUrl, PNG, 'image/png')).ok).toBe(false)
    const [row] = await admin`
      select 1 as one from storage.objects where name = ${issued.data!.path}`
    expect(row).toBeUndefined()
  })

  it('a check a stopped function never finished is cleared when its upload expires', async () => {
    const { token } = await person()
    const stuck = await mutate<FeedbackImageUploadDto>(handler, 'feedback.imageUploadUrl', {
      token,
      input: { contentType: 'image/png' },
    })
    await uploadTo(stuck.data!.uploadUrl, PNG, 'image/png')
    await admin`
      update app.feedback_uploads
         set status = 'checking', expires_at = now() - interval '1 minute'
       where path = ${stuck.data!.path}`
    await mutate(handler, 'feedback.imageUploadUrl', {
      token,
      input: { contentType: 'image/png' },
    })
    const [row] = await admin<{ status: string }[]>`
      select status from app.feedback_uploads where path = ${stuck.data!.path}`
    expect(row?.status).toBe('discarded')
    const [object] = await admin`
      select 1 as one from storage.objects where name = ${stuck.data!.path}`
    expect(object).toBeUndefined()
  })
})

describe('what a signed-in answer tells a cache', () => {
  // Every other response sets its own rules: pages say `private, no-store`, static files `immutable`.
  // /api/trpc said nothing, and it answers GETs with a person's data: Chromium kept them, and sign-out
  // does not empty that cache. With no-store nothing is kept, so `Vary` has nothing to add.
  it('a refusal says it too', async () => {
    const me = await query(handler, 'me', {})
    expect(me.status).toBe(401)
    expect(me.headers.get('cache-control') ?? '').toContain('no-store')
  })

  it('`me` and a business procedure answer with no-store', async () => {
    const { token } = await person()
    const businessId = await setupBusiness(handler, token, WORKSHOP)
    const me = await query(handler, 'me', { token })
    expect(me.status).toBe(200)
    expect(me.headers.get('cache-control') ?? '').toContain('no-store')
    const context = await query(handler, 'business.context', { token, businessId })
    expect(context.status).toBe(200)
    expect(context.headers.get('cache-control') ?? '').toContain('no-store')
  })
})

describe('the workflows on a public repository', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8')

  /** The lines of a workflow that a shell runs. */
  function scriptLines(workflow: string): string[] {
    const script: string[] = []
    let blockIndent: number | null = null
    for (const line of workflow.split(/\r?\n/)) {
      const indent = line.length - line.trimStart().length
      if (blockIndent !== null) {
        if (line.trim() === '' || indent > blockIndent) {
          script.push(line)
          continue
        }
        blockIndent = null
      }
      const run = /^\s*(?:- )?run:\s*(.*)$/.exec(line)
      if (!run) continue
      if (/^[|>][-+]?$/.test(run[1] ?? '')) blockIndent = indent
      else script.push(line)
    }
    return script
  }

  // D-354: "The input reaches the script through env, never pasted into it". This step holds every
  // secret of the environment in its env. `type: choice` is what stands in front of it today.
  it('db-migrate pastes no expression into a script', () => {
    const pasted = scriptLines(read('.github/workflows/db-migrate.yml')).filter((line) =>
      line.includes('${{'),
    )
    expect(pasted).toEqual([])
  })

  // ci.yml installs every dependency on a push to main, with a checkout that keeps its token, and names
  // no `permissions`: the token gets whatever the repository's default is. db-migrate.yml has them.
  it('ci.yml asks for a read-only token', () => {
    expect(read('.github/workflows/ci.yml')).toMatch(/^permissions:\r?\n\s+contents: read\s*$/m)
  })
})
