import type {
  CustomizationDto,
  CustomizeDto,
  LocationDto,
  MemberLocationsDto,
  PayableListDto,
  PurchasePaymentsDto,
  SaleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectAdmin, handlerFor, mutate, SECRET_KEY } from '../helpers'
import { OrderScope, OrdersApi, orderItem } from '../orders'
import { tag } from '../product-costs'
import { dayOf, lastOf } from '../profit'
import { codeOf, line, ok, purchaseInput } from '../purchasing'
import { CAFE_BRANCHES, item, SaleScope } from '../sales'
import { BAKER, CapturedEmails, templateRoleId, WORKSHOP } from '../settings'

// ADVERSARY (M3 Step 6, Release A: permissions and release gates). Each test states the rule the
// release keeps (the plan's Step 6 capability audit, D-278); a failing test is a finding.
//
//   1. "Branches they work in only with branches" (D-278, Q12): a member's branch limit outlives the
//      branches. An employee limited to one branch is locked out of Sales and Orders once that branch
//      is removed and the business switches branches off: every sale or order they enter goes to the
//      only location, which is not "one of their branches" (FORBIDDEN), and nobody can change their
//      branches any more (member.locations / member.updateLocations: CAPABILITY_DISABLED).
//      The first fix refused removing a member's only branch; the check that followed found the limit
//      still outliving the branches: with branches off at the last location (the café's Admin limited
//      to Main loses the business-level line of Real profit and may not change an employee who works
//      everywhere), and with branches on but Sales and Reports off (it still narrows team changes,
//      while "Branches they work in" was gone). Nobody could see or change it there.
//   2. "'Entered by' only with a team (the API sends no name without one)" (D-278): a customer
//      payment's `recordedBy` (and `reversedBy`) carries the member's name in a business run alone,
//      while a sale's and an order's `enteredByName` are null there.

let api: OrdersApi

beforeAll(() => {
  api = new OrdersApi()
})

afterAll(async () => {
  await api.close()
})

describe('1. a branch limit never outlives the branches (Q12, D-278)', () => {
  it('an employee limited to a removed branch can still sell once branches are off, or someone can change their branches', async () => {
    const cafe = await SaleScope.open(api, CAFE_BRANCHES)
    const today = await cafe.today()
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    const marina = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const employee = await api.member(cafe, 'employee')
    const channelId = await cafe.channelId()

    // The owner limits the employee to Marina ("Branches they work in").
    const read = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: employee.memberId }),
    )
    ok(
      await cafe.run<MemberLocationsDto>('member.updateLocations', {
        memberId: employee.memberId,
        version: read.version,
        locationIds: [marina.id],
      }),
    )
    // Control: they sell at Marina.
    const atMarina = ok(
      await cafe.as<{ data: SaleDto }>(employee, 'sale.create', {
        id: newId(),
        source: 'single',
        businessDate: today,
        channelId,
        locationId: marina.id,
        lines: [item(latte.id, '1', '18')],
      }),
    ).data
    expect(atMarina.status).toBe('draft')

    // Marina closes: the owner removes it, then switches branches off (one location is left, so
    // Customize BizCost allows it).
    const removed = await cafe.run('location.remove', { id: marina.id })
    const off = await cafe.run<CustomizeDto>('business.customize', {
      item: { kind: 'capability', key: 'multi_location' },
      enabled: false,
    })

    // The employee enters a sale at the business's only location (the screens send no branch
    // without branches).
    const sale = await cafe.as<{ data: SaleDto }>(employee, 'sale.create', {
      id: newId(),
      source: 'single',
      businessDate: today,
      channelId,
      lines: [item(latte.id, '1', '18')],
    })
    // …and the owner can still see or change the branches they work in.
    const fix = await cafe.run<MemberLocationsDto>('member.locations', {
      memberId: employee.memberId,
    })
    const state = [
      `location.remove: ${codeOf(removed) ?? 'ok'}`,
      `multi_location off: ${codeOf(off) ?? 'ok'}`,
      `employee sale.create: ${codeOf(sale) ?? 'ok'}`,
      `owner member.locations: ${codeOf(fix) ?? 'ok'}`,
    ].join('; ')
    // Either the employee is not limited to a branch that no longer exists in a business without
    // branches, or the screen that lifts the limit is still there (any of the fixes keeps one true).
    expect(sale.error === undefined || fix.error === undefined, state).toBe(true)
  })

  // The fix (M3 Step 6 review): a branch that is a member's only live branch, or a pending
  // invitation's, cannot be removed (ONLY_BRANCH_OF_MEMBERS, as D-129 for products); once their
  // branches are changed it goes; branches are switched off once nobody is limited (the check of the
  // fix: BRANCH_LIMITS_IN_USE), and the member sells at the one left.
  it('removing a member’s only branch is refused until their branches change; then they sell without branches', async () => {
    const cafe = await SaleScope.open(api, CAFE_BRANCHES)
    const today = await cafe.today()
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    const main = ok(await cafe.run<LocationDto[]>('location.list')).find((l) => l.isDefault)!
    const marina = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const employee = await api.member(cafe, 'employee')
    const channelId = await cafe.channelId()
    const limit = async (locationIds: string[]) => {
      const read = ok(
        await cafe.run<MemberLocationsDto>('member.locations', { memberId: employee.memberId }),
      )
      ok(
        await cafe.run('member.updateLocations', {
          memberId: employee.memberId,
          version: read.version,
          locationIds,
        }),
      )
    }
    await limit([marina.id])
    expect(codeOf(await cafe.run('location.remove', { id: marina.id }))).toBe(
      'only_branch_of_members',
    )
    const live = ok(await cafe.run<LocationDto[]>('location.list')).map((l) => l.id)
    expect(live).toContain(marina.id)

    // With Main too, Marina can go: the employee keeps a live branch.
    await limit([marina.id, main.id])
    ok(await cafe.run('location.remove', { id: marina.id }))
    // Their limit (Main, and Marina's history) would outlive the branches: refused until lifted.
    const off = () =>
      cafe.run<CustomizeDto>('business.customize', {
        item: { kind: 'capability', key: 'multi_location' },
        enabled: false,
      })
    expect(codeOf(await off())).toBe('branch_limits_in_use')
    await limit([])
    ok(await off())
    const sale = ok(
      await cafe.as<{ data: SaleDto }>(employee, 'sale.create', {
        id: newId(),
        source: 'single',
        businessDate: today,
        channelId,
        lines: [item(latte.id, '1', '18')],
      }),
    ).data
    expect(sale.locationId).toBe(main.id)
  })

  it('a pending invitation that would give only that branch keeps it too', async () => {
    const emails = new CapturedEmails()
    const handler = handlerFor(
      api.db,
      undefined,
      { supabaseSecretKey: SECRET_KEY },
      { emailSender: emails },
    )
    const cafe = await SaleScope.open(api, CAFE_BRANCHES)
    const main = ok(await cafe.run<LocationDto[]>('location.list')).find((l) => l.isDefault)!
    const marina = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    // An Admin limited to Marina invites someone: the invitation gives Marina only (D-236).
    const admin = await api.member(cafe, 'admin')
    const read = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: read.version,
        locationIds: [marina.id],
      }),
    )
    const salesRole = await templateRoleId(api.db, cafe.owner.user, cafe.id, 'sales')
    ok(
      await mutate(handler, 'invitation.create', {
        token: admin.token,
        businessId: cafe.id,
        input: {
          id: newId(),
          email: `invitee-${newId()}@test.bizcost.local`,
          roleId: salesRole,
          locale: 'en',
        },
      }),
    )
    // The Admin works at Main too now, so only the invitation holds Marina alone.
    const again = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: again.version,
        locationIds: [marina.id, main.id],
      }),
    )
    expect(codeOf(await cafe.run('location.remove', { id: marina.id }))).toBe(
      'only_branch_of_members',
    )
  })

  // The check of the first fix (M3 Step 6 review, case a): a café with branches, its Admin limited to
  // Main, its only location. The limit applies (Real profit without the business-level line, team
  // changes within Main), so branches cannot be switched off while it stands; it is in plain sight
  // in "Branches they work in" and Customize says why, and once lifted the Admin sees the business as
  // the owner does and manages the team again.
  it('branches stay on while a member is limited, even to the last location; lifted, the Admin sees what the owner sees', async () => {
    const cafe = await OrderScope.open(api, CAFE_BRANCHES)
    const { today, month } = await cafe.months()
    const main = ok(await cafe.run<LocationDto[]>('location.list')).find((l) => l.isDefault)!
    const admin = await api.member(cafe, 'admin')
    const employee = await api.member(cafe, 'employee')
    const limitAdmin = async (locationIds: string[]) => {
      const read = ok(
        await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
      )
      expect(read.editable).toBe(true)
      ok(
        await cafe.run('member.updateLocations', {
          memberId: admin.memberId,
          version: read.version,
          locationIds,
        }),
      )
    }
    await limitAdmin([main.id])
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    await cafe.sell({ businessDate: today, lines: [item(latte.id, '2', '18')] })
    const range = { from: dayOf(month, 1), to: lastOf(month) }
    const salesRole = await templateRoleId(api.db, cafe.owner.user, cafe.id, 'sales')
    const changeRole = () =>
      cafe.as(admin, 'member.changeRole', { memberId: employee.memberId, roleId: salesRole })
    // While limited: their branches' sales only, and no change to a member who works everywhere.
    expect((await cafe.summary(range, admin)).businessLevel).toBe(false)
    expect(codeOf(await changeRole())).toBe('forbidden')

    const off = () =>
      cafe.run<CustomizeDto>('business.customize', {
        item: { kind: 'capability', key: 'multi_location' },
        enabled: false,
      })
    expect(codeOf(await off())).toBe('branch_limits_in_use')
    const why = ok(await cafe.run<CustomizationDto>('business.customization'))
    expect([why.locationsInUse, why.branchLimitsInUse]).toEqual([false, true])
    expect(
      ok(await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }))
        .locationIds,
    ).toEqual([main.id])

    await limitAdmin([])
    ok(await off())
    const owner = await cafe.summary(range)
    const theirs = await cafe.summary(range, admin)
    expect(owner.businessLevel).toBe(true)
    expect(theirs.businessLevel).toBe(true)
    expect(theirs.total).toEqual(owner.total)
    ok(await changeRole())
    // With branches off there is nothing to limit, and nothing to show.
    expect(codeOf(await cafe.run('member.locations', { memberId: admin.memberId }))).toBe(
      'capability_disabled',
    )
  })

  it('a pending invitation that gives some branches keeps branches on until it is cancelled', async () => {
    const emails = new CapturedEmails()
    const handler = handlerFor(
      api.db,
      undefined,
      { supabaseSecretKey: SECRET_KEY },
      { emailSender: emails },
    )
    const cafe = await SaleScope.open(api, CAFE_BRANCHES)
    const main = ok(await cafe.run<LocationDto[]>('location.list')).find((l) => l.isDefault)!
    const admin = await api.member(cafe, 'admin')
    const read = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: read.version,
        locationIds: [main.id],
      }),
    )
    const invitationId = newId()
    ok(
      await mutate(handler, 'invitation.create', {
        token: admin.token,
        businessId: cafe.id,
        input: {
          id: invitationId,
          email: `invitee-${newId()}@test.bizcost.local`,
          roleId: await templateRoleId(api.db, cafe.owner.user, cafe.id, 'sales'),
          locale: 'en',
        },
      }),
    )
    // The Admin works everywhere again; the invitation still gives Main only (D-236).
    const again = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: again.version,
        locationIds: [],
      }),
    )
    const off = () =>
      cafe.run<CustomizeDto>('business.customize', {
        item: { kind: 'capability', key: 'multi_location' },
        enabled: false,
      })
    expect(codeOf(await off())).toBe('branch_limits_in_use')
    ok(await cafe.run('invitation.revoke', { id: invitationId }))
    ok(await off())
  })

  // Case b: branches on, Sales and Reports both off. The limit still keeps team changes within the
  // Admin's branches (D-236), so "Branches they work in" is served with branches and a team, whatever
  // modules are on (the plan's Step 6: "only with branches and a team").
  it('with Sales and Reports off, a limit that still narrows team changes can be seen and changed', async () => {
    const cafe = await SaleScope.open(api, CAFE_BRANCHES)
    const marina = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const admin = await api.member(cafe, 'admin')
    const employee = await api.member(cafe, 'employee')
    const read = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: read.version,
        locationIds: [marina.id],
      }),
    )
    for (const id of ['sales', 'reports']) {
      ok(
        await cafe.run<CustomizeDto>('business.customize', {
          item: { kind: 'module', id },
          enabled: false,
        }),
      )
    }
    const salesRole = await templateRoleId(api.db, cafe.owner.user, cafe.id, 'sales')
    const changeRole = () =>
      cafe.as(admin, 'member.changeRole', { memberId: employee.memberId, roleId: salesRole })
    expect(codeOf(await changeRole())).toBe('forbidden')
    const limited = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
    )
    expect(limited.locationIds).toEqual([marina.id])
    expect(limited.editable).toBe(true)
    ok(
      await cafe.run('member.updateLocations', {
        memberId: admin.memberId,
        version: limited.version,
        locationIds: [],
      }),
    )
    ok(await changeRole())
  })

  // The same rule from the other side: the owner works in every branch, and "Branches they work in"
  // shows the owner so and never changes the owner's; a limit of the member made owner goes with the
  // transfer, or it would narrow the new owner where nobody can see or change it.
  it('a member made owner works in every branch', async () => {
    const cafe = await SaleScope.open(api, CAFE_BRANCHES)
    const marina = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const heir = await api.member(cafe, 'admin')
    const employee = await api.member(cafe, 'employee')
    const read = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: heir.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: heir.memberId,
        version: read.version,
        locationIds: [marina.id],
      }),
    )
    ok(await cafe.run('member.transferOwnership', { memberId: heir.memberId }))
    const shown = ok(
      await cafe.as<MemberLocationsDto>(heir, 'member.locations', {
        memberId: employee.memberId,
      }),
    )
    // The new owner changes an employee who works everywhere (only someone who does may, D-236).
    ok(
      await cafe.as(heir, 'member.updateLocations', {
        memberId: employee.memberId,
        version: shown.version,
        locationIds: [marina.id],
      }),
    )
    const [row] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.member_locations
       where business_id = ${cafe.id} and member_id = ${heir.memberId} and deleted_at is null`
    expect(row!.n).toBe(0)
  })

  // Branches go off under the business row's lock, after counting the limits; a limit added at the
  // same time waits for that lock and sees branches off (CAPABILITY_DISABLED), as an invitation by a
  // member whose limit was lifted meanwhile does (CONFLICT): neither leaves a limit without branches.
  describe('a switch in progress', () => {
    /** Holds the business row as a switch does, runs `call`, switches branches off, then commits. */
    async function duringSwitch<T>(
      businessId: string,
      call: () => Promise<T>,
      alsoInSwitch: (sql: postgres.TransactionSql) => Promise<unknown> = async () => undefined,
    ): Promise<T> {
      const holder = connectAdmin()
      try {
        let release!: () => void
        const released = new Promise<void>((resolve) => (release = resolve))
        let holding!: (xid: string) => void
        const held = new Promise<string>((resolve) => (holding = resolve))
        const transaction = holder.begin(async (sql) => {
          await sql`select id from app.businesses where id = ${businessId} for update`
          const [row] = await sql<{ xid: string }[]>`select pg_current_xact_id()::text as xid`
          holding(row!.xid)
          await released
          await sql`
            update app.business_capabilities set enabled = false
             where business_id = ${businessId} and key = 'multi_location'`
          await alsoInSwitch(sql)
        })
        const xid = await held
        const running = call()
        for (let tries = 0; ; tries++) {
          const [waiting] = await api.admin<{ n: number }[]>`
            select count(*)::int as n from pg_locks
             where locktype = 'transactionid' and not granted and transactionid::text = ${xid}`
          if (waiting!.n > 0) break
          if (tries > 600) throw new Error('the call never waited for the switch')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        release()
        await transaction
        return await running
      } finally {
        await holder.end()
      }
    }

    it('a limit saved while branches go off is refused', async () => {
      const cafe = await SaleScope.open(api, CAFE_BRANCHES)
      const main = ok(await cafe.run<LocationDto[]>('location.list')).find((l) => l.isDefault)!
      const employee = await api.member(cafe, 'employee')
      const read = ok(
        await cafe.run<MemberLocationsDto>('member.locations', { memberId: employee.memberId }),
      )
      const saved = await duringSwitch(cafe.id, () =>
        cafe.run('member.updateLocations', {
          memberId: employee.memberId,
          version: read.version,
          locationIds: [main.id],
        }),
      )
      expect(codeOf(saved)).toBe('capability_disabled')
      const [row] = await api.admin<{ n: number }[]>`
        select count(*)::int as n from app.member_locations
         where business_id = ${cafe.id} and deleted_at is null`
      expect(row!.n).toBe(0)
    })

    it('an invitation by a member whose limit was lifted as branches went off is refused', async () => {
      const emails = new CapturedEmails()
      const handler = handlerFor(
        api.db,
        undefined,
        { supabaseSecretKey: SECRET_KEY },
        { emailSender: emails },
      )
      const cafe = await SaleScope.open(api, CAFE_BRANCHES)
      const main = ok(await cafe.run<LocationDto[]>('location.list')).find((l) => l.isDefault)!
      const admin = await api.member(cafe, 'admin')
      const read = ok(
        await cafe.run<MemberLocationsDto>('member.locations', { memberId: admin.memberId }),
      )
      ok(
        await cafe.run('member.updateLocations', {
          memberId: admin.memberId,
          version: read.version,
          locationIds: [main.id],
        }),
      )
      const salesRole = await templateRoleId(api.db, cafe.owner.user, cafe.id, 'sales')
      // The invitation reads the Admin's access (Main only) before the switch's lock; the switch
      // lifts the limit (as the owner would have first) and turns branches off.
      const sent = await duringSwitch(
        cafe.id,
        () =>
          mutate(handler, 'invitation.create', {
            token: admin.token,
            businessId: cafe.id,
            input: {
              id: newId(),
              email: `invitee-${newId()}@test.bizcost.local`,
              roleId: salesRole,
              locale: 'en',
            },
          }),
        (sql) => sql`
          update app.member_locations set deleted_at = now()
           where business_id = ${cafe.id} and member_id = ${admin.memberId}`,
      )
      expect(codeOf(sent)).toBe('conflict')
      const [row] = await api.admin<{ n: number }[]>`
        select count(*)::int as n from app.business_invitations
         where business_id = ${cafe.id} and status = 'pending' and cardinality(location_ids) > 0`
      expect(row!.n).toBe(0)
    })
  })
})

describe('2. no member names on customer payments without a team (D-278)', () => {
  async function recordedNames(scope: OrderScope) {
    const cake = await scope.service('120')
    const customer = await scope.customer()
    const order = await scope.order({
      customerId: customer.id,
      lines: [orderItem(cake.id, '1', '120')],
    })
    const paid = await scope.pay({ orderId: order.id }, '50')
    const reversed = ok(
      await scope.run<{ items: { recordedBy: { name: string | null } | null }[] }>(
        'customerPayment.reverse',
        { id: paid.items[0]!.id },
      ),
    )
    const again = await scope.pay({ orderId: order.id }, '20')
    const listed = ok(
      await scope.run<{
        items: {
          recordedBy: { name: string | null } | null
          reversedBy: { name: string | null } | null
        }[]
      }>('customerPayment.list', { orderId: order.id }),
    )
    return {
      order,
      names: [
        ...again.items.map((p) => p.recordedBy?.name ?? null),
        ...reversed.items.map((p) => p.recordedBy?.name ?? null),
        ...listed.items.flatMap((p) => [p.recordedBy?.name ?? null, p.reversedBy?.name ?? null]),
      ],
    }
  }

  it('control: with a team, who recorded each payment is named', async () => {
    const workshop = await OrderScope.open(api, WORKSHOP)
    const { names } = await recordedNames(workshop)
    expect(names.filter((name) => name !== null).length).toBeGreaterThan(0)
  })

  it('a home baker run alone gets no "recorded by" name, as a sale or an order gets no "entered by"', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const { order, names } = await recordedNames(baker)
    // The order itself follows the rule (enteredByName only with a team).
    expect((await baker.getOrder(order.id)).enteredByName).toBeNull()
    // Its payments do not: the owner's name comes back on each of them.
    expect(names.filter((name) => name !== null)).toEqual([])
  })

  // The fix keeps one rule on every money screen (M3 Step 6 review): a purchase's payments and What
  // you owe name nobody in a business run alone either; with a team they still do.
  it('nor do a purchase’s payments or What you owe, run alone; with a team they do', async () => {
    for (const [answers, team] of [
      [{ ...WORKSHOP, team: 'alone', team_tracking: undefined }, false],
      [WORKSHOP, true],
    ] as const) {
      const shop = await OrderScope.open(api, answers)
      const today = await shop.today()
      const supplier = await shop.supplier()
      const milk = await shop.material()
      const purchase = await shop.buy(
        purchaseInput(today, [line(milk.id, '10', '10')], {
          paymentMethod: 'supplier_credit',
          supplierId: supplier.id,
        }),
      )
      const pay = { id: newId(), purchaseId: purchase.id, businessDate: today, method: 'cash' }
      ok(await shop.run('purchasePayment.record', { ...pay, amount: '30' }))
      const view = ok(
        await shop.run<{ data: PurchasePaymentsDto['data'] }>('purchasePayment.reverse', {
          id: pay.id,
        }),
      ).data
      const owed = ok(
        await shop.run<{ data: PayableListDto['data'] }>('payable.list', { party: 'supplier' }),
      ).data
      const names = [
        ...view.payments.flatMap((p) => [p.recordedBy.name, p.reversedBy?.name ?? null]),
        ...owed.groups.flatMap((g) => g.invoices.map((i) => i.enteredBy.name)),
      ]
      expect(names.length, String(team)).toBeGreaterThan(0)
      if (team) expect(names.every((name) => name !== null)).toBe(true)
      else expect(names.filter((name) => name !== null)).toEqual([])
    }
  })
})
