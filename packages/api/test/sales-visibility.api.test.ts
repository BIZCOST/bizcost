import type { LocationDto, MemberLocationsDto, ProductDto, SaleDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handlerFor, mutate, SECRET_KEY } from './helpers'
import { tag } from './product-costs'
import { codeOf, ok, type Person } from './purchasing'
import { CAFE_BRANCHES, item, PREVIEW_MODULES, SalesApi, SaleScope } from './sales'
import { CapturedEmails, templateRoleId } from './settings'

// Who sees which sales (ROADMAP.md M3 Step 2; Q10, Q12; D-181, D-214, D-054): a member without "see
// every sale" lists, reads, changes and finalizes only the sales they entered, and only while nobody
// else changed them since; they get no totals of the business's sales (H1); a member limited to some
// branches sees and enters only those branches' sales ("Branches they work in", member.locations);
// the delivery cost a member typed is theirs to read, otherwise a `cost`.

let api: SalesApi
let cafe: SaleScope
let today: string
let branch: LocationDto
let mainId: string
let latte: ProductDto
let ali: Person & { memberId: string }
let sara: Person & { memberId: string }
let supervisor: Person & { memberId: string }
let limited: Person & { memberId: string }
let alisSale: SaleDto
let sarasDraft: SaleDto

beforeAll(async () => {
  api = new SalesApi()
  cafe = await SaleScope.open(api, CAFE_BRANCHES)
  today = await cafe.today()
  branch = ok(
    await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
  )
  mainId = ok(await cafe.run<LocationDto[]>('location.list')).find((l) => l.isDefault)!.id
  latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
  ali = await api.member(cafe, 'employee')
  sara = await api.member(cafe, 'employee')
  supervisor = await api.member(cafe, 'supervisor')
  limited = await api.member(cafe, 'sales')
  alisSale = await cafe.sell(
    {
      businessDate: today,
      deliveryNeeded: true,
      deliveryArea: 'Marina',
      deliveryCost: '15',
      lines: [item(latte.id, '2', '18')],
    },
    ali,
  )
  sarasDraft = await cafe.saleDraft(
    { businessDate: today, lines: [item(latte.id, '1', '18')] },
    sara,
  )
}, 120_000)

afterAll(async () => {
  await api.close()
})

describe('a member without "see every sale" (the Employee, Q10)', () => {
  it('lists only their own sales, with no totals of the business', async () => {
    const list = await cafe.sales({}, ali)
    expect(list.items.map((s) => s.id)).toEqual([alisSale.id])
    expect(list.dayTotals).toBeNull()
    expect(list.items[0]).toMatchObject({ mine: true, netTotal: '36' })
  })

  it('reads the delivery cost they typed, never anyone else’s, and no other cost', async () => {
    const own = ok(
      await cafe.as<{ data: SaleDto; meta: { redacted: string[] } }>(ali, 'sale.get', {
        id: alisSale.id,
      }),
    )
    expect(own.data.ownDeliveryCost).toBe('15')
    expect(own.data).not.toHaveProperty('deliveryCost')
    expect(own.data.lines[0]).not.toHaveProperty('cost')
    expect(own.meta.redacted).toEqual(
      expect.arrayContaining(['deliveryCost', 'lines.*.cost', 'lines.*.materials']),
    )
    const theirs = ok(
      await cafe.as<{ data: SaleDto }>(supervisor, 'sale.get', { id: alisSale.id }),
    ).data
    expect(theirs.ownDeliveryCost).toBeNull()
    expect(theirs).not.toHaveProperty('deliveryCost')
  })

  it('gets NOT_FOUND for anyone else’s sale: read, save, discard, finalize', async () => {
    expect(codeOf(await cafe.as(ali, 'sale.get', { id: sarasDraft.id }))).toBe('not_found')
    expect(
      codeOf(
        await cafe.as(ali, 'sale.update', {
          id: sarasDraft.id,
          version: sarasDraft.version,
          businessDate: today,
          channelId: await cafe.channelId(),
          lines: [item(latte.id, '9', '18')],
        }),
      ),
    ).toBe('not_found')
    expect(
      codeOf(
        await cafe.as(ali, 'sale.discard', { id: sarasDraft.id, version: sarasDraft.version }),
      ),
    ).toBe('not_found')
    expect(
      codeOf(await cafe.as(ali, 'sale.post', { id: sarasDraft.id, version: sarasDraft.version })),
    ).toBe('not_found')
    expect(codeOf(await cafe.as(ali, 'sale.reverse', { id: alisSale.id }))).toBe('forbidden')
  })

  it('changes their own draft only while nobody else changed it since (D-214)', async () => {
    const draft = await cafe.saleDraft(
      { businessDate: today, lines: [item(latte.id, '1', '18')] },
      ali,
    )
    const byOwner = ok(
      await cafe.run<{ data: SaleDto }>('sale.update', {
        id: draft.id,
        version: draft.version,
        businessDate: today,
        channelId: await cafe.channelId(),
        lines: [item(latte.id, '3', '18')],
      }),
    ).data
    const refused = await cafe.as(ali, 'sale.update', {
      id: draft.id,
      version: byOwner.version,
      businessDate: today,
      channelId: await cafe.channelId(),
      lines: [item(latte.id, '1', '18')],
    })
    expect(codeOf(refused)).toBe('forbidden')
    expect(
      codeOf(await cafe.as(ali, 'sale.post', { id: draft.id, version: byOwner.version })),
    ).toBe('forbidden')
  })
})

describe('a member who sees every sale but not costs (the Supervisor)', () => {
  it('lists every sale with the day’s totals', async () => {
    const list = await cafe.sales({ from: today, to: today }, supervisor)
    expect(list.items.map((s) => s.id)).toEqual(
      expect.arrayContaining([alisSale.id, sarasDraft.id]),
    )
    expect(list.dayTotals).toEqual([
      { businessDate: today, netTotal: '36', total: '37.8', count: 1 },
    ])
    expect(list.items.find((s) => s.id === alisSale.id)?.enteredByName).toBeTruthy()
  })

  it('saves another member’s draft, keeping a delivery cost it cannot see; setting one is FORBIDDEN', async () => {
    const draft = await cafe.saleDraft(
      {
        businessDate: today,
        deliveryNeeded: true,
        deliveryCost: '12',
        lines: [item(latte.id, '1', '18')],
      },
      sara,
    )
    const base = {
      id: draft.id,
      version: draft.version,
      businessDate: today,
      channelId: await cafe.channelId(),
      deliveryNeeded: true,
      lines: [item(latte.id, '2', '18')],
    }
    expect(codeOf(await cafe.as(supervisor, 'sale.update', { ...base, deliveryCost: '1' }))).toBe(
      'forbidden',
    )
    ok(await cafe.as(supervisor, 'sale.update', base))
    expect((await cafe.sale(draft.id)).deliveryCost).toBe('12')
  })
})

describe('a member limited to some branches (Q12)', () => {
  let branchSale: SaleDto

  beforeAll(async () => {
    const scope = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: limited.memberId }),
    )
    expect(scope).toMatchObject({ locationIds: [], editable: true })
    const saved = ok(
      await cafe.run<MemberLocationsDto>('member.updateLocations', {
        memberId: limited.memberId,
        version: scope.version,
        locationIds: [branch.id],
      }),
    )
    expect(saved).toMatchObject({ locationIds: [branch.id] })
    expect(saved.version).toBe(scope.version + 1)
    branchSale = await cafe.sell({
      businessDate: today,
      locationId: branch.id,
      lines: [item(latte.id, '4', '18')],
    })
  }, 60_000)

  it('sees and enters only their branches’ sales', async () => {
    const list = await cafe.sales({}, limited)
    expect(list.items.map((s) => s.id)).toEqual([branchSale.id])
    expect(list.dayTotals).toEqual([
      { businessDate: today, netTotal: '72', total: '75.6', count: 1 },
    ])
    expect(codeOf(await cafe.as(limited, 'sale.get', { id: alisSale.id }))).toBe('not_found')
    const atMain = await cafe.as(limited, 'sale.create', {
      id: newId(),
      source: 'single',
      businessDate: today,
      locationId: mainId,
      channelId: await cafe.channelId(),
      lines: [item(latte.id, '1', '18')],
    })
    expect(codeOf(atMain)).toBe('forbidden')
    const atDefault = await cafe.as(limited, 'sale.create', {
      id: newId(),
      source: 'single',
      businessDate: today,
      channelId: await cafe.channelId(),
      lines: [item(latte.id, '1', '18')],
    })
    expect(codeOf(atDefault)).toBe('forbidden')
    expect(
      codeOf(
        await cafe.as(limited, 'sale.daySheet', {
          businessDate: today,
          channelId: await cafe.channelId(),
        }),
      ),
    ).toBe('forbidden')
    const atBranch = await cafe.sell(
      { businessDate: today, locationId: branch.id, lines: [item(latte.id, '1', '18')] },
      limited,
    )
    expect(atBranch.locationId).toBe(branch.id)
    // Their day sheet's branch picker lists only their branch; the owner's lists every branch, the
    // default first.
    const theirs = await cafe.sheet(
      { businessDate: today, channelId: await cafe.channelId(), locationId: branch.id },
      limited,
    )
    expect(theirs.locations).toEqual([{ id: branch.id, name: branch.name, isDefault: false }])
    const owners = await cafe.sheet({ businessDate: today, channelId: await cafe.channelId() })
    expect(owners.locations?.[0]).toMatchObject({ id: mainId, isDefault: true })
    expect(owners.locations?.map((l) => l.id)).toContain(branch.id)
  })

  it('"Branches they work in": not the owner, not one’s own, live branches only, the version as read', async () => {
    const owners = (await cafe.run<{ id: string; isOwner: boolean }[]>('member.list')).data!.find(
      (m) => m.isOwner,
    )!
    expect(
      codeOf(
        await cafe.run('member.updateLocations', {
          memberId: owners.id,
          version: 0,
          locationIds: [branch.id],
        }),
      ),
    ).toBe('validation')
    const current = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: limited.memberId }),
    )
    expect(
      codeOf(
        await cafe.run('member.updateLocations', {
          memberId: limited.memberId,
          version: current.version + 5,
          locationIds: [],
        }),
      ),
    ).toBe('conflict')
    expect(
      codeOf(
        await cafe.run('member.updateLocations', {
          memberId: limited.memberId,
          version: current.version,
          locationIds: [newId()],
        }),
      ),
    ).toBe('not_found')
    // A member who may not manage roles never reads nor changes it.
    expect(
      codeOf(await cafe.as(supervisor, 'member.locations', { memberId: limited.memberId })),
    ).toBe('forbidden')
  })

  it('an Admin limited to a branch gives no branch beyond theirs, and changes no one who works everywhere', async () => {
    const admin = await api.member(cafe, 'admin')
    const scope = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: scope.version,
        locationIds: [branch.id],
      }),
    )
    const saras = ok(
      await cafe.as<MemberLocationsDto>(admin, 'member.locations', { memberId: sara.memberId }),
    )
    expect(saras.editable).toBe(false)
    expect(
      codeOf(
        await cafe.as(admin, 'member.updateLocations', {
          memberId: sara.memberId,
          version: saras.version,
          locationIds: [branch.id],
        }),
      ),
    ).toBe('forbidden')
    expect(
      codeOf(
        await cafe.as(admin, 'member.updateLocations', {
          memberId: admin.memberId,
          version: scope.version + 1,
          locationIds: [],
        }),
      ),
    ).toBe('forbidden')
    // Within their branch: a member limited to it may be changed by them (nothing beyond theirs).
    const limitedNow = ok(
      await cafe.as<MemberLocationsDto>(admin, 'member.locations', { memberId: limited.memberId }),
    )
    expect(limitedNow.editable).toBe(true)
    expect(
      codeOf(
        await cafe.as(admin, 'member.updateLocations', {
          memberId: limited.memberId,
          version: limitedNow.version,
          locationIds: [mainId],
        }),
      ),
    ).toBe('forbidden')
  })
})

describe('a member limited to a branch widens no one beyond it (D-236)', () => {
  const emails = new CapturedEmails()
  let inviting: ReturnType<typeof handlerFor>
  let admin: Person & { memberId: string }

  /** An invitation sent by `person`, as stored (its branches and status). */
  async function invite(person: Person, roleId: string) {
    const id = newId()
    ok(
      await mutate(inviting, 'invitation.create', {
        token: person.token,
        businessId: cafe.id,
        input: { id, email: `invitee-${newId()}@test.bizcost.local`, roleId, locale: 'en' },
      }),
    )
    return id
  }

  async function stored(id: string) {
    const [row] = await api.admin<{ location_ids: string[]; status: string }[]>`
      select location_ids, status from app.business_invitations where id = ${id}`
    return row!
  }

  beforeAll(() => {
    inviting = handlerFor(
      api.db,
      undefined,
      { supabaseSecretKey: SECRET_KEY, previewModules: PREVIEW_MODULES },
      { emailSender: emails },
    )
  })

  it('an invitation carries their branches; one sent before they were limited stops working', async () => {
    admin = await api.member(cafe, 'admin')
    const employeeRole = await templateRoleId(api.db, cafe.owner.user, cafe.id, 'employee')
    const before = await invite(admin, employeeRole)
    expect(await stored(before)).toEqual({ location_ids: [], status: 'pending' })
    const scope = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: scope.version,
        locationIds: [branch.id],
      }),
    )
    // Accepted now, it would give every branch: it is revoked with the limit.
    expect((await stored(before)).status).toBe('revoked')
    const after = await invite(admin, employeeRole)
    expect(await stored(after)).toEqual({ location_ids: [branch.id], status: 'pending' })
  })

  it('changes no role, access or membership of someone who works everywhere, nor a role they hold', async () => {
    const salesRole = await templateRoleId(api.db, cafe.owner.user, cafe.id, 'sales')
    // Sara (an Employee) works in every branch.
    expect(
      codeOf(
        await cafe.as(admin, 'member.changeRole', { memberId: sara.memberId, roleId: salesRole }),
      ),
    ).toBe('forbidden')
    const saras = ok(
      await cafe.as<{ editable: boolean; version: number }>(admin, 'member.permissions', {
        memberId: sara.memberId,
      }),
    )
    expect(saras.editable).toBe(false)
    expect(
      codeOf(
        await cafe.as(admin, 'member.updatePermissions', {
          memberId: sara.memberId,
          version: saras.version,
          overrides: [{ key: 'sales.documents.view', effect: 'allow' }],
        }),
      ),
    ).toBe('forbidden')
    expect(codeOf(await cafe.as(admin, 'member.remove', { memberId: sara.memberId }))).toBe(
      'forbidden',
    )
    // The Employee role is held by members who work everywhere: "see every sale" on it is refused.
    const roles = ok(
      await cafe.run<
        { id: string; templateKey: string | null; version: number; permissionKeys: string[] }[]
      >('role.list'),
    )
    const employee = roles.find((r) => r.templateKey === 'employee')!
    expect(
      codeOf(
        await cafe.as(admin, 'role.updatePermissions', {
          id: employee.id,
          version: employee.version,
          permissionKeys: [...employee.permissionKeys, 'sales.documents.view'],
        }),
      ),
    ).toBe('forbidden')
    // A member limited within their branch stays theirs to manage.
    const limiteds = ok(
      await cafe.as<{ editable: boolean }>(admin, 'member.permissions', {
        memberId: limited.memberId,
      }),
    )
    expect(limiteds.editable).toBe(true)
  })
})
