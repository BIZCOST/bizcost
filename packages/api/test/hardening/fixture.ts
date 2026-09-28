import type {
  BusinessProfileDto,
  InvitationDto,
  LocationDto,
  LogoUploadUrlDto,
  MaterialDto,
  MemberDto,
  ProductDto,
  RoleDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import type { RoleTemplateKey } from '@bizcost/modules'
import type { AnyRouter } from '@trpc/server'
import { expect } from 'vitest'
import { middlewareMarkers } from '../../src/trpc'
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
  type CallResult,
  type TestUser,
} from '../helpers'
import { CapturedEmails, join, setupBusiness, WORKSHOP } from '../settings'

// Fixture of the Step 9 hardening suites (ROADMAP.md Step 9): two businesses, each with its owner, a
// second user (Admin) and an Employee, made through the real API the way the web makes them (Smart
// Setup with every capability on, so every procedure is reachable), with a branch, a pending
// invitation, a saved logo and an issued upload. Also: how a procedure is classified (public, authed,
// business; query or mutation) straight from the router, the strings that identify a business's data
// in a response, and a digest of everything a business has in the database and in Storage.
//
// Materials and Products & Services are still planned (M2 Step 2, released with Step 7): the suites run
// the API with the dev-only preview of both (D-125), so their procedures are attacked like the others.

export type Handler = ReturnType<typeof handlerFor>

export interface Person {
  user: TestUser
  token: string
}

export interface Api {
  db: Db
  admin: Admin
  handler: Handler
  emails: CapturedEmails
  newPerson: (metadata?: Record<string, unknown>) => Promise<Person>
  close: () => Promise<void>
}

/** The modules still being built that the suites preview (D-125). */
export const PREVIEW_MODULES = ['materials', 'products'] as const

/**
 * The API as deployed (secret key for Storage, emails kept instead of sent), with the modules still
 * being built previewed, and its test users.
 */
export function openApi(router?: AnyRouter): Api {
  const db = connectApi()
  const admin = connectAdmin()
  const emails = new CapturedEmails()
  const handler = handlerFor(
    db,
    router,
    { supabaseSecretKey: SECRET_KEY, previewModules: PREVIEW_MODULES },
    { emailSender: emails },
  )
  const users: TestUser[] = []
  return {
    db,
    admin,
    handler,
    emails,
    newPerson: async (metadata = { locale: 'en' }) => {
      const user = await createUser(metadata)
      users.push(user)
      return { user, token: await mintToken(user) }
    },
    close: async () => {
      for (const user of users) await deleteUser(user)
      await admin.end()
      await db.$client.end()
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// Procedures, as the router defines them
// ---------------------------------------------------------------------------------------------------

export type Base = 'public' | 'authed' | 'business'
export type ProcedureType = 'query' | 'mutation'

export interface ProcedureInfo {
  path: string
  /** From the middlewares: businessScoped → business, authed → authed, neither → public. */
  base: Base
  type: ProcedureType
  takesInput: boolean
}

interface ProcedureDef {
  type: string
  inputs: unknown[]
  middlewares: unknown[]
}

export function proceduresOf(router: AnyRouter): ProcedureInfo[] {
  return Object.entries(router._def.procedures as Record<string, { _def: ProcedureDef }>)
    .map(([path, procedure]) => {
      const def = procedure._def
      const base: Base = def.middlewares.includes(middlewareMarkers.businessScoped)
        ? 'business'
        : def.middlewares.includes(middlewareMarkers.authed)
          ? 'authed'
          : 'public'
      if (def.type !== 'query' && def.type !== 'mutation') {
        throw new Error(`${path}: ${def.type} procedures are not covered by the hardening suites`)
      }
      const type: ProcedureType = def.type
      return { path, base, type, takesInput: def.inputs.length > 0 }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

export interface CallAs {
  businessId?: string
  input?: unknown
  headers?: Record<string, string>
}

/** Calls a procedure as `token` over HTTP: GET for a query, POST for a mutation (Bearer: no Origin). */
export function callProcedure<T = unknown>(
  handler: Handler,
  procedure: Pick<ProcedureInfo, 'path' | 'type'>,
  token: string | undefined,
  options: CallAs = {},
): Promise<CallResult<T>> {
  const call = procedure.type === 'query' ? query<T> : mutate<T>
  return call(handler, procedure.path, {
    ...(token ? { token } : {}),
    ...(options.businessId ? { businessId: options.businessId } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
}

// ---------------------------------------------------------------------------------------------------
// A business with a team
// ---------------------------------------------------------------------------------------------------

/** A valid 1×1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

export interface Tenant {
  id: string
  label: string
  legalName: string
  legalNameAr: string
  owner: Person
  admin: Person
  employee: Person
  ownerMemberId: string
  adminMemberId: string
  employeeMemberId: string
  roles: Record<RoleTemplateKey, RoleDto>
  defaultLocationId: string
  branch: LocationDto
  invitation: InvitationDto
  /** The raw token of the pending invitation's link. */
  invitationToken: string
  /** The saved logo's object path. */
  logoPath: string
  /** An upload URL issued (registered, still open) but not used. */
  openUpload: LogoUploadUrlDto
  /** A material with two packs (1 carton = 12 bottles, 1 bottle = 1 l). */
  material: MaterialDto
  /** A product sold at the branch only. */
  product: ProductDto
}

function ok<T>(result: CallResult<T>, what: string): T {
  expect(result.error, `${what}: ${result.raw}`).toBeUndefined()
  return result.data as T
}

/** Uploads bytes to a signed upload URL, as the browser does. */
export async function uploadTo(
  url: string,
  bytes: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, ...headers },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(10_000),
  })
  await response.arrayBuffer()
  return response
}

export async function createTenant(api: Api, label: string): Promise<Tenant> {
  const tag = newId().slice(-12)
  const legalName = `Hardening ${label} ${tag}`
  const legalNameAr = `مؤسسة ${label} ${tag}`
  const [owner, admin, employee] = await Promise.all([
    api.newPerson(),
    api.newPerson(),
    api.newPerson(),
  ])
  const id = await setupBusiness(api.handler, owner.token, WORKSHOP, { name: legalName })
  const as = (path: string, type: ProcedureType, input?: unknown) =>
    callProcedure(api.handler, { path, type }, owner.token, { businessId: id, input })

  const adminMemberId = await join(api.db, owner.user, id, admin.user, 'admin')
  const employeeMemberId = await join(api.db, owner.user, id, employee.user, 'employee')
  const members = ok(await as('member.list', 'query'), 'member.list') as MemberDto[]
  const ownerMemberId = members.find((m) => m.isOwner)?.id ?? ''
  const roleList = ok(await as('role.list', 'query'), 'role.list') as RoleDto[]
  const roles = Object.fromEntries(
    roleList.flatMap((role) => (role.templateKey ? [[role.templateKey, role]] : [])),
  ) as Record<RoleTemplateKey, RoleDto>

  const profile = ok(await as('business.profile', 'query'), 'profile') as BusinessProfileDto
  ok(
    await as('business.updateProfile', 'mutation', {
      version: profile.version,
      legalName,
      legalNameAr,
      vatRegistered: false,
      trn: null,
    }),
    'updateProfile',
  )

  const branch = ok(
    await as('location.create', 'mutation', { id: newId(), name: `Branch ${label} ${tag}` }),
    'location.create',
  ) as LocationDto
  const locations = ok(await as('location.list', 'query'), 'location.list') as LocationDto[]
  const defaultLocationId = locations.find((l) => l.isDefault)?.id ?? ''

  const inviteeEmail = `invitee-${label.toLowerCase()}-${tag}@test.bizcost.local`
  const invitation = ok(
    await as('invitation.create', 'mutation', {
      id: newId(),
      email: inviteeEmail,
      roleId: roles.employee.id,
      locale: 'en',
    }),
    'invitation.create',
  ) as InvitationDto
  const invitationToken = api.emails.tokenFor(inviteeEmail)

  const upload = ok(
    await as('business.logoUploadUrl', 'mutation', { contentType: 'image/png' }),
    'logoUploadUrl',
  ) as LogoUploadUrlDto
  expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  ok(await as('business.setLogo', 'mutation', { path: upload.path }), 'setLogo')
  const openUpload = ok(
    await as('business.logoUploadUrl', 'mutation', { contentType: 'image/png' }),
    'logoUploadUrl',
  ) as LogoUploadUrlDto

  const bottle = newId()
  const material = ok(
    await as('material.create', 'mutation', {
      id: newId(),
      name: `Milk ${label} ${tag}`,
      unit: 'l',
      packs: [
        { id: bottle, name: `bottle ${tag}`, qty: '1', ofUnit: 'l' },
        { id: newId(), name: `carton ${tag}`, qty: '12', ofPackId: bottle },
      ],
    }),
    'material.create',
  ) as MaterialDto
  const product = ok(
    await as('product.create', 'mutation', {
      id: newId(),
      name: `Latte ${label} ${tag}`,
      type: 'product',
      unit: 'piece',
      defaultPrice: '15.5',
      locationIds: [branch.id],
    }),
    'product.create',
  ) as ProductDto

  return {
    id,
    label,
    legalName,
    legalNameAr,
    owner,
    admin,
    employee,
    ownerMemberId,
    adminMemberId,
    employeeMemberId,
    roles,
    defaultLocationId,
    branch,
    invitation,
    invitationToken,
    logoPath: upload.path,
    openUpload,
    material,
    product,
  }
}

/** A valid input for a business query that needs one, naming the tenant's own rows. */
export function queryInputOf(path: string, tenant: Tenant): unknown {
  if (path === 'material.get') return { id: tenant.material.id }
  if (path === 'product.get') return { id: tenant.product.id }
  return undefined
}

/**
 * Strings that identify the tenant's data: names, emails, ids of its rows and users, object paths.
 * None of them may appear in a response to someone who is not a member.
 */
export function markersOf(tenant: Tenant): string[] {
  return [
    tenant.id,
    tenant.legalName,
    tenant.legalNameAr,
    tenant.branch.name,
    tenant.branch.id,
    tenant.defaultLocationId,
    tenant.invitation.id,
    tenant.invitation.email,
    tenant.invitationToken,
    tenant.logoPath,
    tenant.openUpload.path,
    tenant.ownerMemberId,
    tenant.adminMemberId,
    tenant.employeeMemberId,
    tenant.material.id,
    tenant.material.name,
    ...tenant.material.packs.flatMap((pack) => [pack.id, pack.name]),
    tenant.product.id,
    tenant.product.name,
    ...Object.values(tenant.roles).map((role) => role.id),
    ...[tenant.owner, tenant.admin, tenant.employee].flatMap(({ user }) => [
      user.id,
      user.email,
      user.email.split('@')[0] ?? user.email,
    ]),
  ]
}

/** The tenant's markers found in `raw`, except those the request itself sent. */
export function leaksOf(raw: string, tenant: Tenant, sent: unknown = undefined): string[] {
  const echoed = sent === undefined ? '' : JSON.stringify(sent)
  const lowered = raw.toLowerCase()
  return markersOf(tenant).filter(
    (marker) => lowered.includes(marker.toLowerCase()) && !echoed.includes(marker),
  )
}

/**
 * A digest of the tenant's state: every row of every app table with its business_id (audit_log
 * included, so a write by anyone shows), its businesses row, its users' profiles and its Storage
 * objects. Read as postgres (BYPASSRLS).
 */
export async function tenantDigest(admin: Admin, tenant: Tenant): Promise<Record<string, string>> {
  const tables = await admin<{ table_name: string }[]>`
    select table_name from information_schema.columns
     where table_schema = 'app' and column_name = 'business_id'
     order by table_name`
  const digest: Record<string, string> = {}
  for (const { table_name } of tables) {
    const [row] = await admin.unsafe<{ h: string }[]>(
      `select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) as h
         from app."${table_name.replaceAll('"', '""')}" t where t.business_id = $1`,
      [tenant.id],
    )
    digest[table_name] = row?.h ?? ''
  }
  const [business] = await admin<{ h: string }[]>`
    select md5(to_jsonb(b)::text) as h from app.businesses b where b.id = ${tenant.id}`
  digest.businesses = business?.h ?? ''
  const userIds = [tenant.owner, tenant.admin, tenant.employee].map(({ user }) => user.id)
  const [profiles] = await admin<{ h: string }[]>`
    select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) as h
      from app.profiles p where p.id = any(${userIds}::uuid[])`
  digest.profiles = profiles?.h ?? ''
  const [objects] = await admin<{ h: string }[]>`
    select md5(coalesce(string_agg(
             concat_ws(':', o.name, o.metadata::text, o.updated_at::text, o.owner_id), '|'
             order by o.name), '')) as h
      from storage.objects o
     where o.bucket_id = 'business-files' and o.name like ${`${tenant.id}/%`}`
  digest.storage = objects?.h ?? ''
  return digest
}
