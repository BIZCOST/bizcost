import type { LocationDto, MemberLocationsDto, SaleDto, SaleListDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  SECRET_KEY,
  type TestUser,
} from '../helpers'
import { tag } from '../product-costs'
import { codeOf, ok, type Person } from '../purchasing'
import { CAFE_BRANCHES, item, PREVIEW_MODULES, SalesApi, SaleScope } from '../sales'
import { BAKER, CapturedEmails, templateRoleId } from '../settings'

// SECURITY REVIEW of M3 Step 2 (sales data and API). Each case is a leak or a bypass found by the
// adversarial review; they fail until the defect is fixed (none is fixed here).
//
// 1. The owner's minutes are a `cost` (catalog.ts: saving them needs the costs switch; recipes.ts and
//    product-costs.ts tag them `cost`; D-119 hides them once the business has a team). A sale finalized
//    while the business had no team freezes `sale_lines.time_minutes` = the product's minutes × qty,
//    and `saleLineDto.timeMinutes` is NOT tagged: once the business takes on a team, any member who
//    sees every sale but not costs reads the owner's minutes per unit (timeMinutes ÷ qty).
//
// 2. "Branches they work in" (Q12, D-231): "a caller limited to branches only [changes] a member
//    limited within them, to some of theirs". member.updateLocations keeps that rule, but the older
//    team procedures do not: an Admin limited to one branch invites a new account (or re-roles a
//    member who works everywhere) with "see every sale", and that member reads the other branches'
//    sales the Admin is limited away from (an Admin's own second account is all it takes).

let api: SalesApi
const emails = new CapturedEmails()
let inviteHandler: ReturnType<typeof handlerFor>
const extraUsers: TestUser[] = []

beforeAll(() => {
  api = new SalesApi()
  inviteHandler = handlerFor(
    api.db,
    undefined,
    { supabaseSecretKey: SECRET_KEY, previewModules: PREVIEW_MODULES },
    { emailSender: emails },
  )
})

afterAll(async () => {
  for (const user of extraUsers) await deleteUser(user)
  await api.close()
})

describe('the owner’s minutes frozen on a sale are a cost (D-119, D-187)', () => {
  it('a member who sees every sale but not costs cannot read them once the business has a team', async () => {
    const baker = await SaleScope.open(api, BAKER)
    const today = await baker.today()
    // Without a team: 30 minutes of the owner's time for one loaf, at 40 an hour.
    const loaf = await baker.product({
      name: `Loaf ${tag()}`,
      defaultPrice: '20',
      ownerMinutes: '30',
    })
    await baker.settings({ ownerHourlyRate: '40' })
    const sale = await baker.sell({ businessDate: today, lines: [item(loaf.id, '2', '20')] })
    // The premise: the owner's sale froze 2 × 30 minutes.
    expect(sale.lines[0]?.timeMinutes).toBe('60')

    // The baker takes on a team, and a Sales member (every sale, no costs switch) joins.
    ok(
      await baker.run('business.customize', {
        item: { kind: 'capability', key: 'has_team' },
        enabled: true,
      }),
    )
    const seller = await api.member(baker, 'sales')
    const context = ok(await baker.as<{ visibleCategories: string[] }>(seller, 'business.context'))
    expect(context.visibleCategories).toEqual([])
    // The same minutes are hidden from them where the product shows them (D-119, D-187).
    const read = ok(
      await baker.as<{ data: SaleDto; meta: { redacted: string[] } }>(seller, 'sale.get', {
        id: sale.id,
      }),
    )
    const line = read.data.lines[0]!
    expect(line).not.toHaveProperty('cost') // the premise: line costs are redacted for them
    expect(line).not.toHaveProperty('timeCost')
    // The leak: 60 minutes for 2 loaves = the owner's 30 minutes per loaf, a `cost`.
    expect(line.timeMinutes ?? null).toBeNull()
  })
})

describe('a member limited to a branch gives no one the branches they are limited away from (Q12, D-231)', () => {
  let cafe: SaleScope
  let today: string
  let branch: LocationDto
  let mainSale: SaleDto
  let admin: Person & { memberId: string }
  let salesRole: string

  beforeAll(async () => {
    cafe = await SaleScope.open(api, CAFE_BRANCHES)
    today = await cafe.today()
    branch = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    // A sale at the main (default) branch.
    mainSale = await cafe.sell({ businessDate: today, lines: [item(latte.id, '3', '18')] })
    // An Admin the owner limits to the Marina branch.
    admin = await api.member(cafe, 'admin')
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
    salesRole = await templateRoleId(api.db, cafe.owner.user, cafe.id, 'sales')
    // The premise: the Admin does not see the main branch's sale.
    const own = ok(await cafe.as<SaleListDto>(admin, 'sale.list', {}))
    expect(own.items.map((s) => s.id)).not.toContain(mainSale.id)
    expect(codeOf(await cafe.as(admin, 'sale.get', { id: mainSale.id }))).toBe('not_found')
  }, 120_000)

  it('an invitation they send makes no member who sees the other branches’ sales', async () => {
    const email = `invitee-${newId()}@test.bizcost.local`
    const invited = await mutate(inviteHandler, 'invitation.create', {
      token: admin.token,
      businessId: cafe.id,
      input: { id: newId(), email, roleId: salesRole, locale: 'en' },
    })
    if (invited.error) {
      // Refusing the invitation is one fix.
      expect(codeOf(invited)).toBe('forbidden')
      return
    }
    const user = await createUser({ locale: 'en' }, { email })
    extraUsers.push(user)
    const invitee: Person = { user, token: await mintToken(user) }
    ok(
      await mutate(inviteHandler, 'invitation.accept', {
        token: invitee.token,
        input: { token: emails.tokenFor(email) },
      }),
    )
    // Limiting the new member to the inviter's branches is the other.
    const list = ok(await cafe.as<SaleListDto>(invitee, 'sale.list', {}))
    expect(list.items.map((s) => s.id)).not.toContain(mainSale.id)
    expect(codeOf(await cafe.as(invitee, 'sale.get', { id: mainSale.id }))).toBe('not_found')
  })

  it('a role change they make gives no member who works everywhere "see every sale"', async () => {
    const employee = await api.member(cafe, 'employee')
    // The premise: an Employee sees only their own sales.
    const before = ok(await cafe.as<SaleListDto>(employee, 'sale.list', {}))
    expect(before.items.map((s) => s.id)).not.toContain(mainSale.id)
    const changed = await cafe.as(admin, 'member.changeRole', {
      memberId: employee.memberId,
      roleId: salesRole,
    })
    if (changed.error) {
      expect(codeOf(changed)).toBe('forbidden')
      return
    }
    const after = ok(await cafe.as<SaleListDto>(employee, 'sale.list', {}))
    expect(after.items.map((s) => s.id)).not.toContain(mainSale.id)
  })
})
