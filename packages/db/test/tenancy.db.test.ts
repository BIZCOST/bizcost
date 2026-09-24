import { newId } from '@bizcost/domain'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  auditLog,
  businessCapabilities,
  businesses,
  businessInvitations,
  businessMembers,
  businessModules,
  locations,
  memberLocations,
  memberPermissionOverrides,
  profiles,
  rolePermissions,
  roles,
  setupAnswers,
  withTenantTx,
  type Db,
  type Tx,
} from '../src'
import {
  connectAdmin,
  connectApi,
  createAuthUser,
  createBusiness,
  ctx,
  failsWith,
  failureMessage,
  newInvitationToken,
  sqlState,
  type Admin,
  type TestBusiness,
  type TestUser,
} from './helpers'

const RLS_VIOLATION = '42501' // also "permission denied"
const FK_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'

let admin: Admin
let db: Db
let userA: TestUser
let userB: TestUser
let bizA: TestBusiness
let bizB: TestBusiness
let locationA: string
let locationB: string

beforeAll(async () => {
  admin = connectAdmin()
  db = connectApi()
  userA = await createAuthUser(admin)
  userB = await createAuthUser(admin)
  bizA = await createBusiness(db, userA, 'Business A')
  bizB = await createBusiness(db, userB, 'Business B')
  locationA = newId()
  locationB = newId()
  await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
    tx.insert(locations).values({ id: locationA, businessId: bizA.id, name: 'A main' }),
  )
  await withTenantTx(db, ctx(userB.id, bizB.id), (tx) =>
    tx.insert(locations).values({ id: locationB, businessId: bizB.id, name: 'B main' }),
  )
})

afterAll(async () => {
  await db?.$client.end()
  await admin?.end()
})

describe('withTenantTx', () => {
  const readContext = sql`select current_setting('app.user_id', true) as user_id,
    current_setting('app.business_id', true) as business_id,
    current_setting('app.request_id', true) as request_id,
    pg_backend_pid() as pid`
  type ContextRow = {
    user_id: string | null
    business_id: string | null
    request_id: string | null
    pid: number
  }

  it('sets the context inside the transaction and leaves the pooled connection clean', async () => {
    const context = ctx(userA.id, bizA.id)
    const [inside] = await withTenantTx(db, context, (tx) => tx.execute<ContextRow>(readContext))
    expect(inside).toMatchObject({
      user_id: context.userId,
      business_id: context.businessId,
      request_id: context.requestId,
    })

    const [after] = await db.execute<ContextRow>(readContext)
    expect(after?.pid).toBe(inside?.pid) // max: 1 → same server connection
    expect(after?.user_id ?? '').toBe('')
    expect(after?.business_id ?? '').toBe('')
    expect(after?.request_id ?? '').toBe('')
  })

  it('leaves the connection clean after a failed transaction', async () => {
    await expect(
      withTenantTx(db, ctx(userA.id, bizA.id), async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const [after] = await db.execute<ContextRow>(readContext)
    expect(after?.user_id ?? '').toBe('')
    expect(after?.business_id ?? '').toBe('')
  })

  it('sets an empty business id when the request has no active business', async () => {
    const [row] = await withTenantTx(db, ctx(userA.id, null), (tx) =>
      tx.execute<{ business_id: string | null }>(
        sql`select app.current_business_id() as business_id`,
      ),
    )
    expect(row?.business_id).toBeNull()
  })
})

describe('fails closed without tenant context', () => {
  const tables = {
    businesses,
    profiles,
    businessCapabilities,
    businessModules,
    locations,
    roles,
    rolePermissions,
    businessMembers,
    memberPermissionOverrides,
    memberLocations,
    businessInvitations,
    setupAnswers,
    auditLog,
  }

  it.each(Object.entries(tables))('bizcost_api reads 0 rows from %s', async (_name, table) => {
    const rows = await db.select().from(table)
    expect(rows).toHaveLength(0)
  })

  it('cannot write without context', async () => {
    const code = await failsWith(
      db
        .insert(locations)
        .values({ id: newId(), businessId: bizA.id, name: 'x', createdBy: userA.id }),
    )
    expect(code).toBe(RLS_VIOLATION)
  })

  it('cannot insert a business directly (only app.create_business)', async () => {
    const code = await failsWith(
      withTenantTx(db, ctx(userA.id, null), (tx) =>
        tx.insert(businesses).values({ id: newId(), legalName: 'Sneaky' }),
      ),
    )
    expect(code).toBe(RLS_VIOLATION)
  })

  it('app.create_business requires a user', async () => {
    const code = await failsWith(
      db.execute(
        sql`select app.create_business(${newId()}, 'X', 'en', 'X', ${newId()}, ${newId()})`,
      ),
    )
    expect(code).toBe(RLS_VIOLATION)
  })
})

describe('isolation between businesses', () => {
  it('a user without an active business sees only their businesses and memberships', async () => {
    const result = await withTenantTx(db, ctx(userA.id, null), async (tx) => ({
      businesses: await tx.select({ id: businesses.id }).from(businesses),
      members: await tx.select({ businessId: businessMembers.businessId }).from(businessMembers),
      locations: await tx.select().from(locations),
    }))
    expect(result.businesses).toEqual([{ id: bizA.id }])
    expect(result.members).toEqual([{ businessId: bizA.id }])
    expect(result.locations).toHaveLength(0)
  })

  it('a member of A reads only A rows', async () => {
    const rows = await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx.select({ id: locations.id, businessId: locations.businessId }).from(locations),
    )
    expect(rows).toEqual([{ id: locationA, businessId: bizA.id }])
  })

  it('a member of A gets nothing when claiming business B as active', async () => {
    const result = await withTenantTx(db, ctx(userA.id, bizB.id), async (tx) => ({
      locations: await tx.select().from(locations).where(eq(locations.businessId, bizB.id)),
      roles: await tx.select().from(roles),
      members: await tx
        .select()
        .from(businessMembers)
        .where(eq(businessMembers.businessId, bizB.id)),
      audit: await tx.select().from(auditLog),
      business: await tx.select().from(businesses).where(eq(businesses.id, bizB.id)),
    }))
    expect(result).toEqual({ locations: [], roles: [], members: [], audit: [], business: [] })
  })

  it('a member of A cannot insert rows into B', async () => {
    for (const businessId of [bizA.id, bizB.id]) {
      const code = await failsWith(
        withTenantTx(db, ctx(userA.id, businessId), (tx) =>
          tx.insert(locations).values({ id: newId(), businessId: bizB.id, name: 'intruder' }),
        ),
      )
      expect(code).toBe(RLS_VIOLATION)
    }
  })

  it('a member of A cannot update or delete B rows', async () => {
    const touched = await withTenantTx(db, ctx(userA.id, bizA.id), async (tx) => ({
      updated: await tx
        .update(locations)
        .set({ name: 'hacked' })
        .where(eq(locations.id, locationB))
        .returning(),
      deleted: await tx.delete(locations).where(eq(locations.id, locationB)).returning(),
      business: await tx
        .update(businesses)
        .set({ legalName: 'hacked' })
        .where(eq(businesses.id, bizB.id))
        .returning(),
    }))
    expect(touched).toEqual({ updated: [], deleted: [], business: [] })
    const [row] = await admin`select name from app.locations where id = ${locationB}`
    expect(row?.name).toBe('B main')
  })

  it('a member of A cannot move an A row into B', async () => {
    const code = await failsWith(
      withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
        tx.update(locations).set({ businessId: bizB.id }).where(eq(locations.id, locationA)),
      ),
    )
    expect([RLS_VIOLATION, CHECK_VIOLATION]).toContain(code)
  })

  it('a child row cannot reference a parent of another business (composite FK)', async () => {
    const rolePermission = failsWith(
      withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
        tx.insert(rolePermissions).values({
          id: newId(),
          businessId: bizA.id,
          roleId: bizB.ownerRoleId,
          permissionKey: 'settings.business.update',
        }),
      ),
    )
    expect(await rolePermission).toBe(FK_VIOLATION)

    const memberLocation = failsWith(
      withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
        tx.insert(memberLocations).values({
          id: newId(),
          businessId: bizA.id,
          memberId: bizA.ownerMemberId,
          locationId: locationB,
        }),
      ),
    )
    expect(await memberLocation).toBe(FK_VIOLATION)
  })

  it('a removed member loses access on the next transaction', async () => {
    const userC = await createAuthUser(admin)
    const memberId = newId()
    const roleId = newId()
    await withTenantTx(db, ctx(userA.id, bizA.id), async (tx) => {
      await tx
        .insert(roles)
        .values({ id: roleId, businessId: bizA.id, name: 'Staff', templateKey: 'staff' })
      await tx.insert(businessMembers).values({
        id: memberId,
        businessId: bizA.id,
        userId: userC.id,
        kind: 'account',
        displayName: 'C',
        status: 'active',
        roleId,
      })
    })
    const before = await withTenantTx(db, ctx(userC.id, bizA.id), (tx) =>
      tx.select().from(locations),
    )
    expect(before).toHaveLength(1)

    await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx.update(businessMembers).set({ status: 'removed' }).where(eq(businessMembers.id, memberId)),
    )
    const after = await withTenantTx(db, ctx(userC.id, bizA.id), (tx) =>
      tx.select().from(locations),
    )
    expect(after).toHaveLength(0)
  })
})

describe('row maintenance', () => {
  it('defaults created_by to the caller and bumps version, updated_at and updated_by', async () => {
    const id = newId()
    const created = await withTenantTx(db, ctx(userA.id, bizA.id), async (tx) => {
      const [row] = await tx
        .insert(locations)
        .values({ id, businessId: bizA.id, name: 'Branch' })
        .returning()
      return row
    })
    expect(created).toMatchObject({ createdBy: userA.id, version: 1, updatedBy: null })

    const [updated] = await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx
        .update(locations)
        .set({ name: 'Branch 2' })
        .where(and(eq(locations.id, id), eq(locations.version, 1)))
        .returning(),
    )
    expect(updated).toMatchObject({ name: 'Branch 2', version: 2, updatedBy: userA.id })
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created!.updatedAt.getTime())

    // Optimistic concurrency: a stale version matches nothing.
    const stale = await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx
        .update(locations)
        .set({ name: 'stale' })
        .where(and(eq(locations.id, id), eq(locations.version, 1)))
        .returning(),
    )
    expect(stale).toHaveLength(0)
  })

  it('rejects changes to id, created_by and created_at', async () => {
    const code = await failsWith(
      withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
        tx.update(locations).set({ createdBy: userB.id }).where(eq(locations.id, locationA)),
      ),
    )
    expect(code).toBe(CHECK_VIOLATION)
  })
})

describe('audit log', () => {
  it('records every write with actor and request_id', async () => {
    const id = newId()
    const insertCtx = ctx(userA.id, bizA.id)
    const updateCtx = ctx(userA.id, bizA.id)
    const deleteCtx = ctx(userA.id, bizA.id)
    await withTenantTx(db, insertCtx, (tx) =>
      tx.insert(locations).values({ id, businessId: bizA.id, name: 'Audited' }),
    )
    await withTenantTx(db, updateCtx, (tx) =>
      tx.update(locations).set({ name: 'Audited 2' }).where(eq(locations.id, id)),
    )
    await withTenantTx(db, deleteCtx, (tx) => tx.delete(locations).where(eq(locations.id, id)))

    const rows = await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      // created_at is now() of each (sequential) transaction; ids are only ordered to the millisecond.
      tx.select().from(auditLog).where(eq(auditLog.entityId, id)).orderBy(auditLog.createdAt),
    )
    expect(rows.map((r) => [r.action, r.requestId, r.actorUserId, r.entity, r.businessId])).toEqual(
      [
        ['insert', insertCtx.requestId, userA.id, 'locations', bizA.id],
        ['update', updateCtx.requestId, userA.id, 'locations', bizA.id],
        ['delete', deleteCtx.requestId, userA.id, 'locations', bizA.id],
      ],
    )
    expect(rows[0]!.changes).toEqual({ after: expect.objectContaining({ name: 'Audited' }) })
    expect(rows[1]!.changes).toEqual({
      before: expect.objectContaining({ name: 'Audited', version: 1 }),
      after: expect.objectContaining({ name: 'Audited 2', version: 2 }),
    })
    expect(rows[2]!.changes).toEqual({ before: expect.objectContaining({ name: 'Audited 2' }) })
  })

  it('records business creation under the new business', async () => {
    const rows = await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'insert')),
    )
    const entities = rows.map((r) => [r.entity, r.entityId])
    expect(entities).toEqual(
      expect.arrayContaining([
        ['businesses', bizA.id],
        ['roles', bizA.ownerRoleId],
        ['business_members', bizA.ownerMemberId],
      ]),
    )
    expect(rows.every((r) => r.actorUserId === userA.id)).toBe(true)
  })

  it('is read-only for bizcost_api (only the audit trigger writes it)', async () => {
    const insert = await failsWith(
      withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
        tx.insert(auditLog).values({
          id: newId(),
          businessId: bizA.id,
          actorUserId: userB.id,
          action: 'delete',
          entity: 'locations',
          entityId: newId(),
          changes: {},
        }),
      ),
    )
    const update = await failsWith(
      withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
        tx.update(auditLog).set({ entity: 'x' }).where(eq(auditLog.businessId, bizA.id)),
      ),
    )
    const del = await failsWith(
      withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
        tx.delete(auditLog).where(eq(auditLog.businessId, bizA.id)),
      ),
    )
    expect([insert, update, del]).toEqual([RLS_VIOLATION, RLS_VIOLATION, RLS_VIOLATION])
  })

  it('never stores invitation token hashes', async () => {
    const id = newId()
    const { tokenHash } = newInvitationToken()
    await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx.insert(businessInvitations).values({
        id,
        businessId: bizA.id,
        email: `hash-${id}@test.bizcost.local`,
        tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
        roleId: bizA.ownerRoleId,
      }),
    )
    const [row] = await admin`select changes from app.audit_log where entity_id = ${id}`
    expect(row?.changes.after).toBeDefined()
    expect(row?.changes.after).not.toHaveProperty('token_hash')
    expect(JSON.stringify(row?.changes)).not.toContain(tokenHash)
  })
})

describe('invitations', () => {
  let staffRoleId: string

  beforeAll(async () => {
    staffRoleId = newId()
    await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx
        .insert(roles)
        .values({ id: staffRoleId, businessId: bizA.id, name: 'Staff', templateKey: 'staff' }),
    )
  })

  async function invite(email: string, extra: { locationIds?: string[] } = {}) {
    const { token, tokenHash } = newInvitationToken()
    await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx.insert(businessInvitations).values({
        id: newId(),
        businessId: bizA.id,
        email,
        tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
        roleId: staffRoleId,
        overrides: { 'sales.order.create': 'allow', 'costs.cost.view': 'deny' },
        locationIds: extra.locationIds ?? [locationA],
        sendCount: 1,
        lastSentAt: new Date(),
      }),
    )
    return token
  }

  function accept(user: TestUser, token: string) {
    return withTenantTx(db, ctx(user.id, null), async (tx) => {
      const [row] = await tx.execute<{ business_id: string }>(
        sql`select app.accept_invitation(${token}, ${newId()}) as business_id`,
      )
      return row?.business_id
    })
  }

  it('matches invitation emails case-insensitively for bizcost_api (citext)', async () => {
    const email = `Mixed.Case-${newId()}@Test.BizCost.Local`
    await invite(email)
    const rows = await withTenantTx(db, ctx(userA.id, bizA.id), (tx) =>
      tx
        .select()
        .from(businessInvitations)
        .where(eq(businessInvitations.email, email.toUpperCase())),
    )
    expect(rows).toHaveLength(1)
  })

  it('allows one pending invitation per email and business', async () => {
    const email = `dup-${newId()}@test.bizcost.local`
    await invite(email)
    expect(await failsWith(invite(email.toUpperCase()))).toBe('23505')
  })

  it('rejects a wrong token, another user and an unverified email with the same error', async () => {
    const invitee = await createAuthUser(admin)
    const token = await invite(invitee.email)
    const stranger = await createAuthUser(admin)
    const unverified = await createAuthUser(admin, { verified: false })
    const unverifiedToken = await invite(unverified.email)

    const messages = await Promise.all([
      failureMessage(accept(invitee, `${token}x`)),
      failureMessage(accept(stranger, token)),
      failureMessage(accept(unverified, unverifiedToken)),
    ])
    expect(messages).toEqual(['invitation_invalid', 'invitation_invalid', 'invitation_invalid'])
  })

  it('accepts: active membership with role, overrides and locations; token is single-use', async () => {
    const invitee = await createAuthUser(admin)
    await withTenantTx(db, ctx(invitee.id, null), (tx) =>
      tx.insert(profiles).values({ id: invitee.id, displayName: 'Invitee Name', locale: 'ar' }),
    )
    // Email case differs from the auth email: still the same person.
    const token = await invite(invitee.email.toUpperCase())
    const acceptCtx = ctx(invitee.id, null)
    const businessId = await withTenantTx(db, acceptCtx, async (tx) => {
      const [row] = await tx.execute<{ business_id: string }>(
        sql`select app.accept_invitation(${token}, ${newId()}) as business_id`,
      )
      return row?.business_id
    })
    expect(businessId).toBe(bizA.id)

    const state = await withTenantTx(db, ctx(invitee.id, bizA.id), async (tx) => {
      const [member] = await tx
        .select()
        .from(businessMembers)
        .where(eq(businessMembers.userId, invitee.id))
      return {
        member,
        overrides: await tx
          .select({
            key: memberPermissionOverrides.permissionKey,
            effect: memberPermissionOverrides.effect,
          })
          .from(memberPermissionOverrides)
          .where(eq(memberPermissionOverrides.memberId, member!.id))
          .orderBy(memberPermissionOverrides.permissionKey),
        locations: await tx
          .select({ locationId: memberLocations.locationId })
          .from(memberLocations)
          .where(eq(memberLocations.memberId, member!.id)),
        audit: await tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.entity, 'business_members'), eq(auditLog.entityId, member!.id))),
      }
    })
    expect(state.member).toMatchObject({
      kind: 'account',
      status: 'active',
      roleId: staffRoleId,
      displayName: 'Invitee Name',
      createdBy: invitee.id,
    })
    expect(state.overrides).toEqual([
      { key: 'costs.cost.view', effect: 'deny' },
      { key: 'sales.order.create', effect: 'allow' },
    ])
    expect(state.locations).toEqual([{ locationId: locationA }])
    expect(state.audit).toMatchObject([
      { action: 'insert', actorUserId: invitee.id, requestId: acceptCtx.requestId },
    ])

    expect(await failureMessage(accept(invitee, token))).toBe('invitation_invalid')
  })

  it('rejects an invitation whose location no longer exists', async () => {
    const invitee = await createAuthUser(admin)
    const token = await invite(invitee.email, { locationIds: [newId()] })
    expect(await failureMessage(accept(invitee, token))).toBe('invitation_invalid')
  })
})

describe('owner invariant', () => {
  it('a business cannot lose its last active owner', async () => {
    const owner = await createAuthUser(admin)
    const biz = await createBusiness(db, owner)
    const code = await failsWith(
      withTenantTx(db, ctx(owner.id, biz.id), (tx) =>
        tx
          .update(businessMembers)
          .set({ status: 'suspended' })
          .where(eq(businessMembers.id, biz.ownerMemberId)),
      ),
    )
    expect(code).toBe(CHECK_VIOLATION)

    const demote = await failsWith(
      withTenantTx(db, ctx(owner.id, biz.id), (tx) =>
        tx.update(roles).set({ templateKey: null }).where(eq(roles.id, biz.ownerRoleId)),
      ),
    )
    expect(demote).toBe(CHECK_VIOLATION)
  })

  it('ownership can move to another member within one transaction', async () => {
    const owner = await createAuthUser(admin)
    const next = await createAuthUser(admin)
    const biz = await createBusiness(db, owner)
    const staffRoleId = newId()
    await withTenantTx(db, ctx(owner.id, biz.id), async (tx) => {
      await tx
        .insert(roles)
        .values({ id: staffRoleId, businessId: biz.id, name: 'Staff', templateKey: 'staff' })
      await tx.insert(businessMembers).values({
        id: newId(),
        businessId: biz.id,
        userId: next.id,
        kind: 'account',
        displayName: 'Next',
        status: 'active',
        roleId: biz.ownerRoleId,
      })
      await tx
        .update(businessMembers)
        .set({ roleId: staffRoleId })
        .where(eq(businessMembers.id, biz.ownerMemberId))
    })
    const owners = await withTenantTx(db, ctx(next.id, biz.id), (tx) =>
      tx
        .select({ userId: businessMembers.userId })
        .from(businessMembers)
        .where(eq(businessMembers.roleId, biz.ownerRoleId)),
    )
    expect(owners).toEqual([{ userId: next.id }])
  })

  it('two concurrent transactions cannot each remove one of the last two owners', async () => {
    const owner = await createAuthUser(admin)
    const coOwner = await createAuthUser(admin)
    const biz = await createBusiness(db, owner)
    const coOwnerMemberId = newId()
    await withTenantTx(db, ctx(owner.id, biz.id), (tx) =>
      tx.insert(businessMembers).values({
        id: coOwnerMemberId,
        businessId: biz.id,
        userId: coOwner.id,
        kind: 'account',
        displayName: 'Co-owner',
        status: 'active',
        roleId: biz.ownerRoleId,
      }),
    )
    const suspend = (tx: Tx, memberId: string) =>
      tx
        .update(businessMembers)
        .set({ status: 'suspended' })
        .where(eq(businessMembers.id, memberId))

    // Immediate checks make the race deterministic: the first transaction has passed its owner
    // check but not committed when the second one runs its own.
    const db2 = connectApi()
    try {
      let allowFirstCommit!: () => void
      const firstMayCommit = new Promise<void>((resolve) => (allowFirstCommit = resolve))
      let firstChecked!: () => void
      const firstHasChecked = new Promise<void>((resolve) => (firstChecked = resolve))
      const first = withTenantTx(db, ctx(owner.id, biz.id), async (tx) => {
        await tx.execute(sql`set constraints all immediate`)
        await suspend(tx, biz.ownerMemberId)
        firstChecked()
        await firstMayCommit
      })
      await firstHasChecked

      let secondSettled = false
      const second = withTenantTx(db2, ctx(coOwner.id, biz.id), async (tx) => {
        await tx.execute(sql`set constraints all immediate`)
        await suspend(tx, coOwnerMemberId)
      }).then(
        () => 'committed',
        (error: unknown) => sqlState(error) ?? String(error),
      )
      void second.finally(() => (secondSettled = true))

      // The second check must wait for the first transaction to end.
      for (let i = 0; i < 100 && !secondSettled; i++) {
        const [row] = await admin<
          { waiting: number }[]
        >`select count(*)::int as waiting from pg_locks where not granted`
        if ((row?.waiting ?? 0) > 0) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      allowFirstCommit()
      await first
      expect(await second).toBe(CHECK_VIOLATION)
    } finally {
      await db2.$client.end()
    }
  })
})
