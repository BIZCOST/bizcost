import type {
  PayableListDto,
  PurchaseDto,
  PurchasePayersDto,
  PurchasePaymentsDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope, type Person } from './purchasing'
import { BAKER, WORKSHOP } from './settings'

// The owner's requests of 2026-09-29 on how purchases are paid, through the real fetch handler:
//   - R3: a payment method on every save and posting; "on credit" needs the supplier, "paid by a
//     member from their own money" an active member of the business; drafts and purchases from before
//     keep none until completed;
//   - R4: what the business still owes (payable.list: to suppliers, to members), payments of it
//     (purchasePayment.record / .reverse / .list) with the books-closed rule, amounts at most what is
//     owed, a purchase with payments reversed only once they are, who may see and do what, and two
//     payments racing for the same amount.

let api: PurchasingApi
let shop: Scope
let today: string
let yesterday: string
let admin: Person & { memberId: string }
let ownerMemberId: string

type Envelope<T> = { data: T; meta: { redacted: string[] } }

beforeAll(async () => {
  api = new PurchasingApi()
  shop = await Scope.open(api, WORKSHOP)
  today = await shop.today()
  const day = new Date(`${today}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  yesterday = day.toISOString().slice(0, 10)
  admin = await api.member(shop, 'admin')
  const payers = ok(await shop.run<PurchasePayersDto>('purchase.payers'))
  ownerMemberId = payers.items.find((p) => p.isMe)?.memberId ?? ''
}, 60_000)

afterAll(async () => {
  await api.close()
})

/** A tax invoice for 10 × 10 at 5 % VAT (105 in all), bought as `extra` says. */
async function bought(extra: object, date = today): Promise<PurchaseDto> {
  const milk = await shop.material()
  return shop.buy(
    purchaseInput(date, [line(milk.id, '10', '10', { vatRate: '5' })], {
      documentType: 'tax_invoice',
      ...extra,
    }),
  )
}

async function payments(purchaseId: string, as: Person = shop.owner) {
  return ok(
    await shop.as<Envelope<PurchasePaymentsDto['data']>>(as, 'purchasePayment.list', {
      purchaseId,
    }),
  )
}

function pay(purchaseId: string, amount: string, extra: object = {}) {
  return {
    id: newId(),
    purchaseId,
    businessDate: today,
    method: 'bank_transfer',
    amount,
    ...extra,
  }
}

/** Everything owed to suppliers or to members: every page of payable.list, its groups together. */
async function owed(party: 'supplier' | 'member', as: Person = shop.owner, scope: Scope = shop) {
  const first = ok(await scope.as<Envelope<PayableListDto['data']>>(as, 'payable.list', { party }))
  const groups = [...first.data.groups]
  let cursor = first.data.nextCursor
  while (cursor) {
    const page = ok(
      await scope.as<Envelope<PayableListDto['data']>>(as, 'payable.list', { party, cursor }),
    )
    expect(page.data.total).toBe(first.data.total)
    groups.push(...page.data.groups)
    cursor = page.data.nextCursor
  }
  return { ...first, data: { ...first.data, groups, nextCursor: null } }
}

describe('R3: how a purchase was paid', () => {
  it('is required on every save, with no method picked for you', async () => {
    const milk = await shop.material()
    const input = purchaseInput(today, [line(milk.id, '1', '1')])
    // Left out (undefined is not sent).
    const without = { ...input, paymentMethod: undefined }
    expect(codeOf(await shop.run('purchase.create', without))).toBe('validation')
    expect(codeOf(await shop.run('purchase.create', { ...input, paymentMethod: null }))).toBe(
      'validation',
    )
    for (const method of ['cash', 'card', 'bank_transfer', 'cheque', 'other']) {
      const fresh = purchaseInput(today, [line(milk.id, '1', '1')])
      const draft = await shop.draft({ ...fresh, paymentMethod: method })
      expect(draft).toMatchObject({ paymentMethod: method, paidByMemberId: null })
    }
  })

  it('on credit needs the supplier; paid by a member needs an active member of this business', async () => {
    const milk = await shop.material()
    const supplier = await shop.supplier()
    const base = purchaseInput(today, [line(milk.id, '1', '1')])
    const fresh = () => purchaseInput(today, [line(milk.id, '1', '1')])
    expect(
      codeOf(await shop.run('purchase.create', { ...base, paymentMethod: 'supplier_credit' })),
    ).toBe('validation')
    const onCredit = await shop.draft({
      ...fresh(),
      supplierId: supplier.id,
      paymentMethod: 'supplier_credit',
    })
    expect(onCredit).toMatchObject({ paymentMethod: 'supplier_credit', supplierId: supplier.id })

    expect(
      codeOf(await shop.run('purchase.create', { ...base, paymentMethod: 'paid_by_member' })),
    ).toBe('validation')
    expect(
      codeOf(
        await shop.run('purchase.create', {
          ...base,
          paymentMethod: 'cash',
          paidByMemberId: admin.memberId,
        }),
      ),
    ).toBe('validation')
    const byAdmin = await shop.draft({
      ...fresh(),
      paymentMethod: 'paid_by_member',
      paidByMemberId: admin.memberId,
    })
    expect(byAdmin).toMatchObject({
      paymentMethod: 'paid_by_member',
      paidByMemberId: admin.memberId,
      paidByMemberName: admin.user.email.split('@')[0],
    })

    // A member of another business, or one who left, is not found.
    const other = await Scope.open(api, BAKER)
    const stranger = ok(await other.run<PurchasePayersDto>('purchase.payers')).items[0]!.memberId
    const leaver = await api.member(shop, 'employee')
    await api.admin`
      update app.business_members set status = 'removed'
       where business_id = ${shop.id} and id = ${leaver.memberId}`
    for (const memberId of [stranger, leaver.memberId, newId()]) {
      expect(
        codeOf(
          await shop.run('purchase.create', {
            ...base,
            id: newId(),
            paymentMethod: 'paid_by_member',
            paidByMemberId: memberId,
          }),
        ),
        memberId,
      ).toBe('not_found')
    }
  })

  it('purchase.payers: the active members by name, the caller first picked; only for those who enter purchases', async () => {
    const payers = ok(await shop.as<PurchasePayersDto>(admin, 'purchase.payers')).items
    expect(payers.find((p) => p.isMe)?.memberId).toBe(admin.memberId)
    expect(payers.filter((p) => p.isMe)).toHaveLength(1)
    expect(payers.map((p) => p.memberId)).toContain(ownerMemberId)
    expect(payers.map((p) => p.name)).toEqual(
      [...payers.map((p) => p.name)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    )
    const accountant = await api.member(shop, 'accountant')
    expect(codeOf(await shop.as(accountant, 'purchase.payers'))).toBe('forbidden')
  })

  it('a draft saved before without one: posting it says so, and it is completed before it is saved again', async () => {
    const milk = await shop.material()
    const draft = await shop.draft(purchaseInput(today, [line(milk.id, '1', '2')]))
    await api.admin`update app.purchases set payment_method = null where id = ${draft.id}`
    const legacy = ok(await shop.run<Envelope<PurchaseDto>>('purchase.get', { id: draft.id })).data
    expect(legacy.paymentMethod).toBeNull()
    expect(codeOf(await shop.run('purchase.post', { id: draft.id, version: legacy.version }))).toBe(
      'payment_method_required',
    )
    const without = { ...purchaseInput(today, [line(milk.id, '1', '2')]), paymentMethod: undefined }
    expect(
      codeOf(
        await shop.run('purchase.update', { ...without, id: draft.id, version: legacy.version }),
      ),
    ).toBe('validation')
    const completed = ok(
      await shop.run<Envelope<PurchaseDto>>('purchase.update', {
        ...without,
        paymentMethod: 'card',
        id: draft.id,
        version: legacy.version,
      }),
    ).data
    expect((await shop.post(completed)).status).toBe('posted')
  })

  it('a purchase posted before keeps no method: it is reversed and corrected, and the copy is completed', async () => {
    const posted = await bought({})
    // As if posted before the method was required (the guards are off for this one change).
    await api.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`
      await sql`update app.purchases set payment_method = null where id = ${posted.id}`
    })
    const copyId = newId()
    const copy = ok(
      await shop.run<Envelope<PurchaseDto>>('purchase.correct', { id: posted.id, newId: copyId }),
    ).data
    expect(copy).toMatchObject({ status: 'draft', paymentMethod: null, copiedFromId: posted.id })
    expect(codeOf(await shop.run('purchase.post', { id: copyId, version: copy.version }))).toBe(
      'payment_method_required',
    )
  })
})

describe('R4: what is owed, and paying it', () => {
  it('a purchase on credit is owed to its supplier until paid: partly, then the rest', async () => {
    const supplier = await shop.supplier()
    const purchase = await bought({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
    expect(purchase.total).toBe('105')

    const before = (await owed('supplier')).data
    const group = before.groups.find((g) => g.partyId === supplier.id)!
    expect(group).toMatchObject({ party: 'supplier', name: supplier.name, active: true })
    expect(group.invoices).toEqual([
      expect.objectContaining({
        purchaseId: purchase.id,
        total: '105',
        returned: '0',
        paid: '0',
        outstanding: '105',
        enteredBy: { memberId: ownerMemberId, name: expect.any(String) },
      }),
    ])
    expect(group.outstanding).toBe('105')

    const first = pay(purchase.id, '40', { method: 'cash', note: '  first part  ' })
    const after = ok(
      await shop.run<Envelope<PurchasePaymentsDto['data']>>('purchasePayment.record', first),
    ).data
    expect(after).toMatchObject({
      owedTo: { party: 'supplier', partyId: supplier.id, name: supplier.name },
      total: '105',
      paid: '40',
      outstanding: '65',
    })
    expect(after.payments).toEqual([
      expect.objectContaining({
        id: first.id,
        amount: '40',
        method: 'cash',
        note: 'first part',
        status: 'recorded',
        businessDate: today,
        recordedBy: { memberId: ownerMemberId, name: expect.any(String) },
        reversedBy: null,
      }),
    ])
    // The same payment again is the same answer; the same id with another payload is CONFLICT.
    expect(ok(await shop.run('purchasePayment.record', first))).toEqual({
      data: after,
      meta: { redacted: [] },
    })
    expect(codeOf(await shop.run('purchasePayment.record', { ...first, amount: '41' }))).toBe(
      'conflict',
    )

    // More than is owed, too many decimals, before the purchase, after today.
    expect(codeOf(await shop.run('purchasePayment.record', pay(purchase.id, '65.01')))).toBe(
      'exceeds_outstanding',
    )
    expect(codeOf(await shop.run('purchasePayment.record', pay(purchase.id, '1.001')))).toBe(
      'validation',
    )
    expect(
      codeOf(
        await shop.run(
          'purchasePayment.record',
          pay(purchase.id, '1', { businessDate: yesterday }),
        ),
      ),
    ).toBe('validation')
    expect(
      codeOf(
        await shop.run(
          'purchasePayment.record',
          pay(purchase.id, '1', { businessDate: '2999-01-01' }),
        ),
      ),
    ).toBe('future_date')

    // A return of 1 of the 10 (10.50 with VAT) lowers what is owed.
    const returned = await shop.postReturn(
      await shop.returnDraft({
        id: newId(),
        purchaseId: purchase.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, qty: '1' }],
      }),
    )
    expect(returned.total).toBe('10.5')
    expect((await payments(purchase.id)).data).toMatchObject({
      returned: '10.5',
      outstanding: '54.5',
    })

    ok(await shop.run('purchasePayment.record', pay(purchase.id, '54.5', { method: 'cheque' })))
    const paid = (await payments(purchase.id)).data
    expect(paid).toMatchObject({ paid: '94.5', outstanding: '0' })
    expect(paid.payments.map((p) => p.amount)).toEqual(['54.5', '40'])
    expect((await owed('supplier')).data.groups.some((g) => g.partyId === supplier.id)).toBe(false)
    expect(codeOf(await shop.run('purchasePayment.record', pay(purchase.id, '0.01')))).toBe(
      'exceeds_outstanding',
    )
  })

  it('a purchase a member paid for is owed to that member', async () => {
    const purchase = await bought({
      paymentMethod: 'paid_by_member',
      paidByMemberId: admin.memberId,
    })
    const groups = (await owed('member')).data.groups
    const group = groups.find((g) => g.partyId === admin.memberId)!
    expect(group).toMatchObject({ party: 'member', active: true })
    expect(group.invoices.map((i) => i.purchaseId)).toContain(purchase.id)
    expect((await payments(purchase.id)).data.owedTo).toEqual({
      party: 'member',
      partyId: admin.memberId,
      name: admin.user.email.split('@')[0],
    })
    // Not in the suppliers' tab.
    expect(
      (await owed('supplier')).data.groups.some((g) =>
        g.invoices.some((i) => i.purchaseId === purchase.id),
      ),
    ).toBe(false)
  })

  it('nothing is paid on a purchase paid when bought, a draft or a reversed purchase', async () => {
    const cash = await bought({ paymentMethod: 'cash' })
    expect((await payments(cash.id)).data).toMatchObject({ owedTo: null, outstanding: '0' })
    expect(codeOf(await shop.run('purchasePayment.record', pay(cash.id, '1')))).toBe('validation')

    const supplier = await shop.supplier()
    const milk = await shop.material()
    const draft = await shop.draft(
      purchaseInput(today, [line(milk.id, '1', '5')], {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
    expect((await payments(draft.id)).data).toMatchObject({ status: 'draft', outstanding: '0' })
    expect(codeOf(await shop.run('purchasePayment.record', pay(draft.id, '1')))).toBe(
      'document_not_posted',
    )
    const reversed = await shop.reverse((await shop.post(draft)).id)
    expect(codeOf(await shop.run('purchasePayment.record', pay(reversed.id, '1')))).toBe(
      'document_not_posted',
    )
    expect(codeOf(await shop.run('purchasePayment.record', pay(newId(), '1')))).toBe('not_found')
  })

  it('a purchase with payments is reversed or corrected only once its payments are reversed', async () => {
    const supplier = await shop.supplier()
    const purchase = await bought({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
    const payment = pay(purchase.id, '10')
    ok(await shop.run('purchasePayment.record', payment))
    expect(codeOf(await shop.run('purchase.reverse', { id: purchase.id }))).toBe(
      'purchase_has_payments',
    )
    expect(codeOf(await shop.run('purchase.correct', { id: purchase.id, newId: newId() }))).toBe(
      'purchase_has_payments',
    )

    const undone = ok(
      await shop.run<Envelope<PurchasePaymentsDto['data']>>('purchasePayment.reverse', {
        id: payment.id,
      }),
    ).data
    expect(undone).toMatchObject({ paid: '0', outstanding: '105' })
    expect(undone.payments[0]).toMatchObject({
      status: 'reversed',
      reversalDate: today,
      reversedBy: { memberId: ownerMemberId },
    })
    // Reversing it again changes nothing.
    expect(
      ok(
        await shop.run<Envelope<PurchasePaymentsDto['data']>>('purchasePayment.reverse', {
          id: payment.id,
        }),
      ).data,
    ).toEqual(undone)
    expect((await shop.reverse(purchase.id)).status).toBe('reversed')

    // Every write left its audit row: the payment's insert and its reversal.
    const [audit] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where business_id = ${shop.id} and entity = 'purchase_payments' and entity_id = ${payment.id}`
    expect(audit?.n).toBe(2)
  })

  it('the books-closed rule: no payment on a closed day; a reversal moves to the first open day', async () => {
    const scope = await Scope.open(api, WORKSHOP)
    const supplier = await scope.supplier()
    const milk = await scope.material()
    const purchase = await scope.buy(
      purchaseInput(yesterday, [line(milk.id, '2', '10')], {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
    const early = pay(purchase.id, '5', { businessDate: yesterday })
    ok(await scope.run('purchasePayment.record', early))
    ok(await scope.run('books.close', { closedThrough: yesterday }))
    expect(
      codeOf(
        await scope.run(
          'purchasePayment.record',
          pay(purchase.id, '1', { businessDate: yesterday }),
        ),
      ),
    ).toBe('books_closed')
    const moved = ok(
      await scope.run<Envelope<PurchasePaymentsDto['data']>>('purchasePayment.reverse', {
        id: early.id,
      }),
    ).data
    expect(moved.payments[0]).toMatchObject({
      status: 'reversed',
      businessDate: yesterday,
      reversalDate: today,
    })
    // Closed up to today: a payment dated today, reversed, would be dated tomorrow: refused.
    const late = pay(purchase.id, '5')
    ok(await scope.run('purchasePayment.record', late))
    ok(await scope.run('books.close', { closedThrough: today }))
    expect(codeOf(await scope.run('purchasePayment.reverse', { id: late.id }))).toBe('books_closed')
    ok(await scope.run('books.close', { closedThrough: null }))
  })

  it('a return after it was paid leaves it overpaid: said, and it is no longer owed', async () => {
    const supplier = await shop.supplier()
    const purchase = await bought({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
    ok(await shop.run('purchasePayment.record', pay(purchase.id, '105')))
    expect((await payments(purchase.id)).data).toMatchObject({ outstanding: '0', overpaid: '0' })
    await shop.postReturn(
      await shop.returnDraft({
        id: newId(),
        purchaseId: purchase.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, qty: '1' }],
      }),
    )
    // 105 − 10.5 − 105 = −10.5: nothing is owed, and 10.50 was paid beyond what it came to.
    expect((await payments(purchase.id)).data).toMatchObject({
      total: '105',
      returned: '10.5',
      paid: '105',
      outstanding: '0',
      overpaid: '10.5',
    })
    expect((await owed('supplier')).data.groups.some((g) => g.partyId === supplier.id)).toBe(false)
    // A purchase paid when bought is never overpaid.
    const cash = await bought({ paymentMethod: 'cash' })
    expect((await payments(cash.id)).data).toMatchObject({ outstanding: '0', overpaid: '0' })
  })

  it('what is owed comes a page of suppliers at a time, each with all it is owed', async () => {
    // A business of its own, so that only these are owed.
    const own = await Scope.open(api, WORKSHOP)
    const date = await own.today()
    const buy = async (supplierId: string, price: string) => {
      const material = await own.material()
      return own.buy(
        purchaseInput(date, [line(material.id, '1', price)], {
          supplierId,
          paymentMethod: 'supplier_credit',
        }),
      )
    }
    const tag = newId().slice(-6)
    const [a, b, c] = [
      await own.supplier(`A dairy ${tag}`),
      await own.supplier(`b farm ${tag}`),
      await own.supplier(`C mill ${tag}`),
    ]
    await buy(a!.id, '10')
    const first = await buy(b!.id, '20')
    await buy(b!.id, '30')
    await buy(c!.id, '40')
    ok(await own.run('purchasePayment.record', { ...pay(first.id, '5'), businessDate: date }))

    const page = (cursor?: string) =>
      own.run<Envelope<PayableListDto['data']>>('payable.list', {
        party: 'supplier',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })
    const one = ok(await page()).data
    // By name, any case; what is owed to all of them on every page.
    expect(one.groups.map((g) => g.name)).toEqual([a!.name, b!.name])
    expect(one.total).toBe('95')
    expect(one.groups[1]).toMatchObject({ invoiceCount: 2, outstanding: '45' })
    expect(one.groups[1]!.invoices.map((i) => i.outstanding)).toEqual(['15', '30'])
    expect(one.nextCursor).toEqual(expect.any(String))
    const two = ok(await page(one.nextCursor!)).data
    expect(two.groups.map((g) => g.name)).toEqual([c!.name])
    expect(two).toMatchObject({ total: '95', nextCursor: null })
    // A cursor this server did not make is VALIDATION.
    expect(codeOf(await page('not-a-cursor'))).toBe('validation')
    // Nothing owed: no groups, a total of 0.
    expect(ok(await own.run('payable.list', { party: 'member' }))).toMatchObject({
      data: { groups: [], total: '0', nextCursor: null },
    })
  })

  it('who may see and do what; amounts need supplier prices', async () => {
    const supplier = await shop.supplier()
    const purchase = await bought({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
    const manager = await api.member(shop, 'manager')
    const accountant = await api.member(shop, 'accountant')
    const employee = await api.member(shop, 'employee')
    const withoutPrices = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, withoutPrices.user, {
      template: 'manager',
      overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
    })

    // The Manager (and the Admin) view and record.
    expect((await owed('supplier', manager)).data.groups.length).toBeGreaterThan(0)
    ok(await shop.as(manager, 'purchasePayment.record', pay(purchase.id, '1')))
    ok(await shop.as(admin, 'purchasePayment.record', pay(purchase.id, '1')))
    // The Accountant and the Employee templates do neither.
    for (const person of [accountant, employee]) {
      expect(codeOf(await shop.as(person, 'payable.list', { party: 'supplier' }))).toBe('forbidden')
      expect(
        codeOf(await shop.as(person, 'purchasePayment.list', { purchaseId: purchase.id })),
      ).toBe('forbidden')
      expect(codeOf(await shop.as(person, 'purchasePayment.record', pay(purchase.id, '1')))).toBe(
        'forbidden',
      )
    }
    // Without supplier prices: no list of what is owed (it filters on amounts), no payment (it is
    // checked against what is owed), and a purchase's payments without their amounts.
    expect(codeOf(await shop.as(withoutPrices, 'payable.list', { party: 'supplier' }))).toBe(
      'forbidden',
    )
    expect(
      codeOf(await shop.as(withoutPrices, 'purchasePayment.record', pay(purchase.id, '1'))),
    ).toBe('forbidden')
    const hidden = await payments(purchase.id, withoutPrices)
    expect(hidden.meta.redacted).toEqual(
      expect.arrayContaining(['total', 'returned', 'paid', 'outstanding', 'payments.*.amount']),
    )
    expect(hidden.data.payments).toHaveLength(2)
    expect(hidden.data.payments.every((p) => p.amount === undefined)).toBe(true)
    expect(hidden.data.outstanding).toBeUndefined()
  })

  it('two payments racing for what is owed: never more than the total is paid', async () => {
    const supplier = await shop.supplier()
    const purchase = await bought({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
    const results = await Promise.all(
      Array.from({ length: 4 }, () => shop.run('purchasePayment.record', pay(purchase.id, '60'))),
    )
    expect(results.filter((r) => r.error === undefined)).toHaveLength(1)
    expect(results.map(codeOf).filter((c) => c !== undefined)).toEqual([
      'exceeds_outstanding',
      'exceeds_outstanding',
      'exceeds_outstanding',
    ])
    expect((await payments(purchase.id)).data).toMatchObject({ paid: '60', outstanding: '45' })
  })

  it('a payment racing the reversal of its purchase: one of them is refused', async () => {
    const supplier = await shop.supplier()
    const purchase = await bought({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
    const [payment, reversal] = await Promise.all([
      shop.run('purchasePayment.record', pay(purchase.id, '5')),
      shop.run('purchase.reverse', { id: purchase.id }),
    ])
    const outcomes = [codeOf(payment) ?? 'ok', codeOf(reversal) ?? 'ok'].sort()
    expect([
      ['document_not_posted', 'ok'],
      ['ok', 'purchase_has_payments'],
    ]).toContainEqual(outcomes)
  })
})
