import type { BusinessProfileDto, LogoUploadUrlDto } from '@bizcost/contracts'
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
  query,
  SECRET_KEY,
  SUPABASE_URL,
  type Admin,
  type TestUser,
} from './helpers'
import { appCode, join, setupBusiness, WORKSHOP } from './settings'

// The business logo in the private bucket `business-files` (ROADMAP.md Step 6, docs/ARCHITECTURE.md
// §Storage): signed upload URL → upload → setLogo checks the object → short-lived signed download URL.
// Attacks: another business's prefix, malformed paths, content that is not the declared image,
// SVG and oversize uploads, missing objects, members without settings.business.edit. Every upload URL
// is registered (app.file_uploads); expired unused uploads are removed when the next URL is issued.

let db: Db
let admin: Admin
let handler: ReturnType<typeof handlerFor>
const users: TestUser[] = []

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY })
})

afterAll(async () => {
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

async function newUser() {
  const user = await createUser({ locale: 'en' })
  users.push(user)
  return { user, token: await mintToken(user) }
}

/** A valid 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
/** The start of a JPEG (the API checks the first bytes only). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
/** RIFF....WEBP */
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
])
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>')

function uploadUrl(token: string, businessId: string, contentType: string) {
  return mutate<LogoUploadUrlDto>(handler, 'business.logoUploadUrl', {
    token,
    businessId,
    input: { contentType },
  })
}

/** Uploads bytes to a signed upload URL, as the browser does. */
function upload(url: string, bytes: Buffer, contentType: string) {
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'x-upsert': 'false' },
    body: new Uint8Array(bytes),
  })
}

function setLogo(token: string, businessId: string, path: string) {
  return mutate<BusinessProfileDto>(handler, 'business.setLogo', {
    token,
    businessId,
    input: { path },
  })
}

/** Whether the object exists in the bucket (checked with the secret key). */
async function objectExists(path: string): Promise<boolean> {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/business-files/${path}`, {
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}` },
  })
  await response.arrayBuffer()
  return response.ok
}

async function uploaded(token: string, businessId: string, bytes: Buffer, type: string) {
  const { data, error } = await uploadUrl(token, businessId, type)
  expect(error).toBeUndefined()
  const response = await upload(data!.uploadUrl, bytes, type)
  expect(response.ok, await response.text()).toBe(true)
  return data!
}

describe('business logo', () => {
  it('uploads through a signed URL, saves it and serves it through a short-lived signed URL', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const { path, maxBytes } = await uploaded(owner.token, businessId, PNG, 'image/png')
    expect(path).toMatch(new RegExp(`^${businessId}/logo/[0-9a-f-]{36}\\.png$`))
    expect(maxBytes).toBe(2 * 1024 * 1024)

    const saved = await setLogo(owner.token, businessId, path)
    expect(saved.error).toBeUndefined()
    expect(saved.data?.logoUrl).toContain('/storage/v1/object/sign/business-files/')
    const image = await fetch(saved.data!.logoUrl!)
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true)
    const [row] = await admin<{ logo_path: string }[]>`
      select logo_path from app.businesses where id = ${businessId}`
    expect(row?.logo_path).toBe(path)

    // A manager (settings.business.view) sees it too.
    const manager = await newUser()
    await join(db, owner.user, businessId, manager.user, 'manager')
    const view = await query<BusinessProfileDto>(handler, 'business.profile', {
      token: manager.token,
      businessId,
    })
    expect(view.data?.logoUrl).toBeTruthy()

    // Replacing removes the previous object; removing clears the logo and its object.
    const next = await uploaded(owner.token, businessId, WEBP, 'image/webp')
    expect((await setLogo(owner.token, businessId, next.path)).error).toBeUndefined()
    expect(await objectExists(path)).toBe(false)
    const removed = await mutate<BusinessProfileDto>(handler, 'business.removeLogo', {
      token: owner.token,
      businessId,
    })
    expect(removed.data?.logoUrl).toBeNull()
    expect(await objectExists(next.path)).toBe(false)
  })

  it('accepts JPEG and WebP', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    for (const [bytes, type] of [
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp'],
    ] as const) {
      const { path } = await uploaded(owner.token, businessId, bytes, type)
      expect((await setLogo(owner.token, businessId, path)).error, type).toBeUndefined()
    }
  })

  it('refuses content that is not the declared image and removes it (MIME spoofing)', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    // HTML declared as PNG: the bucket takes it (it checks the declared type), the API does not.
    const html = await uploaded(owner.token, businessId, HTML, 'image/png')
    expect(appCode(await setLogo(owner.token, businessId, html.path))).toBe('file_invalid')
    expect(await objectExists(html.path)).toBe(false)
    // A PNG uploaded under a .jpg path with type image/jpeg.
    const mismatch = await uploaded(owner.token, businessId, PNG, 'image/jpeg')
    expect(appCode(await setLogo(owner.token, businessId, mismatch.path))).toBe('file_invalid')
    const [row] = await admin<{ logo_path: string | null }[]>`
      select logo_path from app.businesses where id = ${businessId}`
    expect(row?.logo_path).toBeNull()
  })

  it('never offers SVG, and the bucket refuses SVG and files over 2 MB', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    expect(appCode(await uploadUrl(owner.token, businessId, 'image/svg+xml'))).toBe('validation')
    const { data } = await uploadUrl(owner.token, businessId, 'image/png')
    const svg = await upload(
      data!.uploadUrl,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
      'image/svg+xml',
    )
    expect(svg.ok).toBe(false)
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])
    const tooBig = await upload(data!.uploadUrl, big, 'image/png')
    expect(tooBig.ok).toBe(false)
    expect(appCode(await setLogo(owner.token, businessId, data!.path))).toBe('file_invalid')
  })

  it('refuses paths outside this business’s logo folder (tampering)', async () => {
    const a = await newUser()
    const b = await newUser()
    const bizA = await setupBusiness(handler, a.token, WORKSHOP)
    const bizB = await setupBusiness(handler, b.token, WORKSHOP)
    const logoB = await uploaded(b.token, bizB, PNG, 'image/png')
    const logoA = await uploaded(a.token, bizA, PNG, 'image/png')
    const file = logoA.path.split('/').at(-1)!
    for (const path of [
      logoB.path, // another business's object
      `${bizA}/logo/../../${logoB.path}`,
      `${bizA}/other/${file}`,
      `${bizA}/logo/${file}.png`,
      `${bizA.toUpperCase()}/logo/${file}`,
      `/${logoA.path}`,
      `${bizA}/logo/${newId()}.svg`,
    ]) {
      expect(appCode(await setLogo(a.token, bizA, path)), path).toBe('validation')
    }
    // Well formed but never uploaded.
    expect(appCode(await setLogo(a.token, bizA, `${bizA}/logo/${newId()}.png`))).toBe(
      'file_invalid',
    )
    const [row] = await admin<{ logo_path: string | null }[]>`
      select logo_path from app.businesses where id = ${bizA}`
    expect(row?.logo_path).toBeNull()
    expect(await objectExists(logoB.path)).toBe(true)
  })

  it('removes an upload left unused once its URL expired, when the next URL is issued', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const unused = await uploaded(owner.token, businessId, PNG, 'image/png')
    expect(await objectExists(unused.path)).toBe(true)
    await admin`update app.file_uploads set expires_at = now() - interval '1 minute'
                 where path = ${unused.path}`
    expect((await uploadUrl(owner.token, businessId, 'image/png')).error).toBeUndefined()
    expect(await objectExists(unused.path)).toBe(false)
    const [row] = await admin<{ status: string }[]>`
      select status from app.file_uploads where path = ${unused.path}`
    expect(row?.status).toBe('discarded')
    // And it can no longer be saved as the logo.
    expect(appCode(await setLogo(owner.token, businessId, unused.path))).toBe('file_invalid')
  })

  it('is for settings.business.edit only', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const { path } = await uploaded(owner.token, businessId, PNG, 'image/png')
    for (const template of ['manager', 'accountant', 'employee'] as const) {
      const member = await newUser()
      await join(db, owner.user, businessId, member.user, template)
      expect(appCode(await setLogo(member.token, businessId, path)), template).toBe('forbidden')
      const remove = await mutate(handler, 'business.removeLogo', {
        token: member.token,
        businessId,
      })
      expect(appCode(remove), template).toBe('forbidden')
    }
    const adminMember = await newUser()
    await join(db, owner.user, businessId, adminMember.user, 'admin')
    expect((await setLogo(adminMember.token, businessId, path)).error).toBeUndefined()
  })
})
