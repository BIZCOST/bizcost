import type {
  BooksDto,
  MaterialDto,
  PurchaseDto,
  PurchaseListDto,
  SupplierDto,
  SupplierListDto,
} from '@bizcost/contracts'
import { newId, roundForDisplay } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  codeOf,
  line,
  milkInput,
  ok,
  purchaseInput,
  PurchasingApi,
  Scope,
  type Person,
} from './purchasing'
import { BAKER, WORKSHOP } from './settings'

// Suppliers and Purchases through the real fetch handler (ROADMAP.md M2 Step 3; D-114, D-115,
// D-120): the module gates (planned until Step 7, reachable through the dev-only preview), suppliers,
// drafts that change nothing, posting with the weighted average, the owner's worked example, the VAT
// rule, discounts and delivery, idempotent posting, reversal and correction, the books-closed date,
// the material cost view (90-day average and last purchase price), permissions per role template and
// redaction. The database is read as postgres to compare the ledger with its projections.

let api: PurchasingApi
let shop: Scope

beforeAll(async () => {
  api = new PurchasingApi()
  shop = await Scope.open(api, WORKSHOP)
}, 60_000)

afterAll(async () => {
  await api.close()
})

describe('the module gates', () => {
  it('released code: suppliers, purchases and books are MODULE_DISABLED, even for the owner', async () => {
    for (const path of ['supplier.list', 'purchase.list', 'purchaseReturn.list', 'books.get']) {
      const result = await api.call(shop.owner, shop.id, path, undefined, api.released)
      expect(codeOf(result), path).toBe('module_disabled')
    }
  })
})

describe('suppliers', () => {
  it('are created once per id, named once per business, updated by version, archived', async () => {
    const id = newId()
    const input = {
      id,
      name: 'Al Ain Dairy',
      phone: ' +971 ٥٠ 123 4567 ',
      email: 'orders@example.test',
      trn: '100-200-300-400-500',
      notes: 'Delivers on Mondays',
    }
    const created = ok(await shop.run<SupplierDto>('supplier.create', input))
    expect(created).toMatchObject({
      id,
      name: 'Al Ain Dairy',
      phone: '+971 50 123 4567',
      trn: '100200300400500',
      archivedAt: null,
      version: 1,
    })
    // The same payload again returns it; another payload with the id is CONFLICT.
    expect(ok(await shop.run<SupplierDto>('supplier.create', input)).id).toBe(id)
    expect(codeOf(await shop.run('supplier.create', { ...input, notes: 'other' }))).toBe('conflict')
    expect(codeOf(await shop.run('supplier.create', { id: newId(), name: 'al ain dairy' }))).toBe(
      'name_taken',
    )
    expect(codeOf(await shop.run('supplier.create', { id: newId(), name: 'X', trn: '123' }))).toBe(
      'validation',
    )
    expect(
      codeOf(await shop.run('supplier.create', { id: newId(), name: 'Y', email: 'not-an-email' })),
    ).toBe('validation')

    const updated = ok(
      await shop.run<SupplierDto>('supplier.update', {
        id,
        version: 1,
        name: 'Al Ain Dairy LLC',
        phone: null,
      }),
    )
    expect(updated).toMatchObject({
      name: 'Al Ain Dairy LLC',
      phone: null,
      email: null,
      version: 2,
    })
    expect(codeOf(await shop.run('supplier.update', { id, version: 1, name: 'Late' }))).toBe(
      'conflict',
    )
    const archived = ok(await shop.run<SupplierDto>('supplier.archive', { id }))
    expect(archived.archivedAt).not.toBeNull()
    const list = ok(
      await shop.run<SupplierListDto>('supplier.list', { search: 'ain dairy', status: 'archived' }),
    )
    expect(list.items.map((s) => s.id)).toEqual([id])
    expect(ok(await shop.run<SupplierDto>('supplier.unarchive', { id })).archivedAt).toBeNull()
  })
})

describe('the owner’s worked example (M2 definition of done)', () => {
  it('50 L at AED 6 then 100 L at AED 7: 6.666666666667, shown 6.67; reversing the second: 6', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const supplier = await shop.supplier()

    // A draft never changes the average (D-114 rule 1).
    const first = await shop.draft(
      purchaseInput(today, [line(milk.id, '50', '6')], { supplierId: supplier.id }),
    )
    expect(first).toMatchObject({ status: 'draft', total: '300', vatInCost: null, costTotal: null })
    expect((await shop.costs([milk.id]))[0]).toMatchObject({ average: null, lastPurchase: null })
    expect(await shop.costRow(milk.id)).toBeUndefined()

    const posted = await shop.post(first)
    expect(posted).toMatchObject({ status: 'posted', costTotal: '300', vatInCost: true })
    expect(posted.lines[0]).toMatchObject({ baseQty: '50000', cost: '300' })
    expect(await shop.costRow(milk.id)).toEqual({ qty: '50000', value: '300', avg_cost: '0.006' })

    const second = await shop.buy(purchaseInput(today, [line(milk.id, '100', '7')]))
    expect(await shop.costRow(milk.id)).toEqual({
      qty: '150000',
      value: '1000',
      avg_cost: '0.006666666667',
    })
    const [cost] = await shop.costs([milk.id])
    expect(cost?.average).toMatchObject({
      basis: 'purchases_90_days',
      perUnit: '6.666666666667',
      perBaseUnit: '0.006666666667',
      to: today,
    })
    expect(roundForDisplay(cost!.average!.perUnit!, 2)).toBe('6.67')
    expect(cost?.lastPurchase).toMatchObject({
      purchaseId: second.id,
      businessDate: today,
      qty: '100',
      unit: 'l',
      pricePerPurchaseUnit: '7',
      pricePerUnit: '7',
      pricePerBaseUnit: '0.007',
    })

    const reversed = await shop.reverse(second.id)
    expect(reversed).toMatchObject({ status: 'reversed', reversalDate: today })
    expect(await shop.costRow(milk.id)).toEqual({ qty: '50000', value: '300', avg_cost: '0.006' })
    const [after] = await shop.costs([milk.id])
    expect(after?.average).toMatchObject({ perUnit: '6', perBaseUnit: '0.006' })
    expect(after?.lastPurchase?.purchaseId).toBe(first.id)
    await shop.expectRebuildEqualsProjections()
  })
})

describe('a reversal after later receipts (D-109, D-114 rule 3)', () => {
  it('the average is as if the reversed purchase had never been posted; later ones stay', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const first = await shop.buy(purchaseInput(today, [line(milk.id, '50', '6')]))
    const second = await shop.buy(purchaseInput(today, [line(milk.id, '100', '7')]))
    await shop.buy(purchaseInput(today, [line(milk.id, '30', '8')]))
    // (300 + 700 + 240) ÷ 180 L
    expect(await shop.costRow(milk.id)).toEqual({
      qty: '180000',
      value: '1240',
      avg_cost: '0.006888888889',
    })

    // The middle one: (300 + 240) ÷ 80 L.
    await shop.reverse(second.id)
    expect(await shop.costRow(milk.id)).toEqual({ qty: '80000', value: '540', avg_cost: '0.00675' })
    // Then the first, received before both others: 240 ÷ 30 L.
    await shop.reverse(first.id)
    expect(await shop.costRow(milk.id)).toEqual({ qty: '30000', value: '240', avg_cost: '0.008' })
    const [cost] = await shop.costs([milk.id])
    expect(cost?.average).toMatchObject({ perUnit: '8', perBaseUnit: '0.008' })
    // Nothing was used in between, so no reversal booked a correction.
    const [corrections] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements
       where business_id = ${shop.id} and material_id = ${milk.id} and adjustment <> 0`
    expect(corrections?.n).toBe(0)
    await shop.expectRebuildEqualsProjections()
  })
})

describe('the carton (PRODUCT.md §4 rule 8)', () => {
  it('1 carton of 12 × 1 L for AED 72 is AED 0.006 per ml and AED 72 per carton', async () => {
    const today = await shop.today()
    const { input, carton } = milkInput()
    const milk = await shop.material(input)
    await shop.buy(
      purchaseInput(today, [
        {
          kind: 'material',
          id: newId(),
          materialId: milk.id,
          qty: '1',
          packId: carton,
          unitPrice: '72',
        },
      ]),
    )
    const [cost] = await shop.costs([milk.id])
    expect(cost?.average).toMatchObject({ perBaseUnit: '0.006', perUnit: '6' })
    expect(cost?.lastPurchase).toMatchObject({
      packId: carton,
      packName: 'carton',
      qty: '1',
      pricePerPurchaseUnit: '72',
      pricePerBaseUnit: '0.006',
    })
  })
})

describe('what the goods cost (D-114 rule 4)', () => {
  it('VAT stays out of the cost for a VAT-registered business with a tax invoice', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const tax = await shop.buy(
      purchaseInput(today, [line(milk.id, '10', '10', { vatRate: '5' })], {
        documentType: 'tax_invoice',
      }),
    )
    expect(tax).toMatchObject({ netTotal: '100', vatTotal: '5', total: '105', vatInCost: false })
    expect(tax.costTotal).toBe('100')

    const marked = await shop.buy(
      purchaseInput(today, [line(milk.id, '10', '10', { vatRate: '5' })], {
        documentType: 'tax_invoice',
        vatNotReclaimable: true,
      }),
    )
    expect(marked).toMatchObject({ vatInCost: true, costTotal: '105' })
    const nonTax = await shop.buy(
      purchaseInput(today, [line(milk.id, '10', '10', { vatRate: '5' })], {
        documentType: 'non_tax_invoice',
      }),
    )
    expect(nonTax).toMatchObject({ vatInCost: true, costTotal: '105' })
  })

  it('VAT is part of the cost for a business that is not VAT-registered, whatever the document', async () => {
    const baker = await Scope.open(api, BAKER)
    const today = await baker.today()
    const flour = await baker.material({ id: newId(), name: 'Flour', unit: 'kg', packs: [] })
    const purchase = await baker.buy(
      purchaseInput(today, [line(flour.id, '10', '5', { unit: 'kg', vatRate: '5' })], {
        documentType: 'tax_invoice',
      }),
    )
    expect(purchase).toMatchObject({ vatInCost: true, costTotal: '52.5' })
  })

  it('discounts come off before VAT; the document discount and the delivery are split by line net', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const beans = await shop.material({
      id: newId(),
      name: `Beans ${newId()}`,
      unit: 'kg',
      packs: [],
    })
    const purchase = await shop.buy(
      purchaseInput(
        today,
        [
          line(milk.id, '30', '10', { vatRate: '5', discount: { percent: '10' } }),
          line(beans.id, '2', '50', { unit: 'kg', vatRate: '5' }),
          { kind: 'delivery', id: newId(), description: 'Delivery', amount: '20', vatRate: '5' },
        ],
        { documentType: 'tax_invoice', discount: { amount: '19' } },
      ),
    )
    // Nets 270 and 100: the discount 19 → 13.86 / 5.14; delivery 20 → 14.59 / 5.41.
    expect(purchase.lines.map((l) => [l.net, l.documentDiscount, l.taxable, l.vat])).toEqual([
      ['270', '13.86', '256.14', '12.81'],
      ['100', '5.14', '94.86', '4.74'],
      ['20', '0', '20', '1'],
    ])
    expect(purchase.lines.map((l) => [l.deliveryShare, l.cost])).toEqual([
      ['14.59', '270.73'],
      ['5.41', '100.27'],
      [null, null],
    ])
    expect(purchase).toMatchObject({
      discountTotal: '49',
      netTotal: '371',
      vatTotal: '18.55',
      total: '389.55',
      costTotal: '371',
    })
    expect(await shop.costRow(beans.id)).toMatchObject({ qty: '2000', value: '100.27' })
  })
})

describe('drafts and posting', () => {
  it('a draft is edited by version; a posted purchase is never edited, posting twice changes nothing', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const draft = await shop.draft(purchaseInput(today, [line(milk.id, '5', '6')]))
    const edited = ok(
      await shop.run<{ data: PurchaseDto }>('purchase.update', {
        id: draft.id,
        version: draft.version,
        businessDate: today,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        reference: 'INV-7',
        lines: [line(milk.id, '6', '6'), line(milk.id, '1', '2')],
      }),
    ).data
    expect(edited).toMatchObject({ reference: 'INV-7', total: '38', version: draft.version + 1 })
    expect(
      codeOf(
        await shop.run('purchase.update', {
          id: draft.id,
          version: draft.version,
          businessDate: today,
          documentType: 'no_invoice',
          paymentMethod: 'cash',
        }),
      ),
    ).toBe('conflict')

    const posted = await shop.post(edited)
    const again = ok(
      await shop.run<{ data: PurchaseDto }>('purchase.post', {
        id: draft.id,
        version: edited.version,
      }),
    ).data
    expect(again).toEqual(posted)
    const [movements] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements m
        join app.purchase_lines l on l.id = m.purchase_line_id
       where l.purchase_id = ${draft.id}`
    expect(movements?.n).toBe(2)
    expect(await shop.costRow(milk.id)).toMatchObject({ qty: '7000', value: '38' })

    for (const [path, input] of [
      [
        'purchase.update',
        {
          id: draft.id,
          version: posted.version,
          businessDate: today,
          documentType: 'no_invoice',
          paymentMethod: 'cash',
        },
      ],
      ['purchase.discard', { id: draft.id, version: posted.version }],
    ] as const) {
      expect(codeOf(await shop.run(path, input)), path).toBe('document_posted')
    }
  })

  it('refuses what cannot be posted: no material, a future date, a unit of another kind', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const empty = await shop.draft(purchaseInput(today, []))
    expect(codeOf(await shop.run('purchase.post', { id: empty.id, version: empty.version }))).toBe(
      'validation',
    )
    const future = await shop.draft(purchaseInput('2999-01-01', [line(milk.id, '1', '1')]))
    expect(
      codeOf(await shop.run('purchase.post', { id: future.id, version: future.version })),
    ).toBe('future_date')
    expect(
      codeOf(
        await shop.run(
          'purchase.create',
          purchaseInput(today, [line(milk.id, '1', '1', { unit: 'kg' })]),
        ),
      ),
    ).toBe('validation')
    expect(
      codeOf(await shop.run('purchase.create', purchaseInput(today, [line(newId(), '1', '1')]))),
    ).toBe('not_found')
  })

  it('quantities and prices may be typed with Arabic-Indic digits', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const posted = await shop.buy(purchaseInput(today, [line(milk.id, '٥٠', '٦٫٥')]))
    expect(posted.lines[0]).toMatchObject({ qty: '50', unitPrice: '6.5', cost: '325' })
  })

  it('discard takes a draft out of the list', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const draft = await shop.draft(purchaseInput(today, [line(milk.id, '1', '1')]))
    ok(await shop.run('purchase.discard', { id: draft.id, version: draft.version }))
    expect(codeOf(await shop.run('purchase.get', { id: draft.id }))).toBe('not_found')
    const list = ok(
      await shop.run<PurchaseListDto>('purchase.list', { status: 'draft', limit: 100 }),
    )
    expect(list.data.items.map((p) => p.id)).not.toContain(draft.id)
  })

  it('a material with purchases keeps its kind of measure', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    await shop.draft(purchaseInput(today, [line(milk.id, '1', '1')]))
    const result = await shop.run<MaterialDto>('material.update', {
      id: milk.id,
      version: milk.version,
      name: milk.name,
      unit: 'kg',
    })
    expect(codeOf(result)).toBe('material_in_use')
    // Another unit of the same kind is fine.
    const litres = ok(
      await shop.run<MaterialDto>('material.update', {
        id: milk.id,
        version: milk.version,
        name: milk.name,
        unit: 'ml',
        packs: milk.packs,
      }),
    )
    expect(litres.unit).toBe('ml')
  })
})

describe('correct = reverse + a new draft copy', () => {
  it('reverses the purchase and opens a copy, once per new id', async () => {
    const today = await shop.today()
    const milk = await shop.material()
    const posted = await shop.buy(
      purchaseInput(today, [line(milk.id, '10', '6')], { reference: 'R-1', notes: 'typo' }),
    )
    const newIdOfCopy = newId()
    const copy = ok(
      await shop.run<{ data: PurchaseDto }>('purchase.correct', {
        id: posted.id,
        newId: newIdOfCopy,
      }),
    ).data
    expect(copy).toMatchObject({
      id: newIdOfCopy,
      status: 'draft',
      copiedFromId: posted.id,
      reference: 'R-1',
      notes: 'typo',
      total: '60',
    })
    expect(copy.lines.map((l) => [l.materialId, l.qty, l.unitPrice])).toEqual([
      [milk.id, '10', '6'],
    ])
    expect(
      ok(await shop.run<{ data: PurchaseDto }>('purchase.get', { id: posted.id })).data.status,
    ).toBe('reversed')
    expect(await shop.costRow(milk.id)).toMatchObject({ qty: '0', value: '0' })
    // Again: the same copy; another purchase with the same new id: CONFLICT.
    expect(
      ok(
        await shop.run<{ data: PurchaseDto }>('purchase.correct', {
          id: posted.id,
          newId: newIdOfCopy,
        }),
      ).data.id,
    ).toBe(newIdOfCopy)
    const other = await shop.buy(purchaseInput(today, [line(milk.id, '1', '1')]))
    expect(codeOf(await shop.run('purchase.correct', { id: other.id, newId: newIdOfCopy }))).toBe(
      'conflict',
    )
    // A draft is edited, not corrected.
    expect(codeOf(await shop.run('purchase.correct', { id: newIdOfCopy, newId: newId() }))).toBe(
      'document_not_posted',
    )
  })
})

describe('the books-closed date (D-114 rule 6)', () => {
  it('blocks posting and reversing on or before it; a reversal of a closed day is dated the first open day', async () => {
    const scope = await Scope.open(api, WORKSHOP)
    const today = await scope.today()
    const milk = await scope.material()
    const yesterday = new Date(`${today}T00:00:00Z`)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const day = yesterday.toISOString().slice(0, 10)
    const old = await scope.buy(purchaseInput(day, [line(milk.id, '10', '5')]))
    const draft = await scope.draft(purchaseInput(day, [line(milk.id, '10', '6')]))

    const closed = ok(await scope.run<BooksDto>('books.close', { closedThrough: day }))
    expect(closed).toEqual({ closedThrough: day, today })
    expect(codeOf(await scope.run('books.close', { closedThrough: '2999-01-01' }))).toBe(
      'future_date',
    )
    expect(codeOf(await scope.run('purchase.post', { id: draft.id, version: draft.version }))).toBe(
      'books_closed',
    )
    // The purchase's own day is closed: its reversal is dated today, the first open day.
    const reversed = await scope.reverse(old.id)
    expect(reversed).toMatchObject({ status: 'reversed', reversalDate: today })
    const [movement] = await api.admin<{ business_date: string }[]>`
      select business_date::text from app.stock_movements
       where business_id = ${scope.id} and kind = 'reversal'`
    expect(movement?.business_date).toBe(today)

    // Moving it back is allowed (and audited).
    ok(await scope.run('books.close', { closedThrough: null }))
    expect((await scope.post(draft)).status).toBe('posted')
    const [audited] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where business_id = ${scope.id} and entity = 'businesses'
         and changes -> 'after' ->> 'books_closed_through' is distinct from
             changes -> 'before' ->> 'books_closed_through'`
    expect(audited?.n).toBe(2)
    await scope.expectRebuildEqualsProjections()
  })

  it('closed up to today: nothing is posted or reversed until the books open again', async () => {
    const scope = await Scope.open(api, WORKSHOP)
    const today = await scope.today()
    const milk = await scope.material()
    const posted = await scope.buy(purchaseInput(today, [line(milk.id, '10', '5')]))
    const draft = await scope.draft(purchaseInput(today, [line(milk.id, '1', '5')]))
    ok(await scope.run('books.close', { closedThrough: today }))
    // Its first open day would be tomorrow: a reversal is never dated in the future.
    expect(codeOf(await scope.run('purchase.reverse', { id: posted.id }))).toBe('books_closed')
    expect(codeOf(await scope.run('purchase.correct', { id: posted.id, newId: newId() }))).toBe(
      'books_closed',
    )
    expect(codeOf(await scope.run('purchase.post', { id: draft.id, version: draft.version }))).toBe(
      'books_closed',
    )
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '10000', value: '50' })
    ok(await scope.run('books.close', { closedThrough: null }))
    expect((await scope.reverse(posted.id)).reversalDate).toBe(today)
  })
})

describe('permissions by role template (PRODUCT.md §8)', () => {
  let purchase: PurchaseDto
  const team = {} as Record<'manager' | 'accountant' | 'sales' | 'supervisor' | 'employee', Person>

  beforeAll(async () => {
    const today = await shop.today()
    const milk = await shop.material()
    purchase = await shop.buy(purchaseInput(today, [line(milk.id, '2', '6.5')]))
    for (const template of ['manager', 'accountant', 'sales', 'supervisor', 'employee'] as const) {
      team[template] = await api.member({ id: shop.id, owner: shop.owner }, template)
    }
  })

  it('Manager does everything but close the books', async () => {
    const manager = team.manager
    expect(ok(await shop.as<PurchaseListDto>(manager, 'purchase.list')).data.items.length).toBe(
      (await shop.run<PurchaseListDto>('purchase.list')).data?.data.items.length,
    )
    expect(ok(await shop.as<BooksDto>(manager, 'books.get')).closedThrough).toBeNull()
    // Closing needs purchases.books.close, which only the Owner and Admin templates hold.
    const refused = await shop.as(manager, 'books.close', { closedThrough: await shop.today() })
    expect(codeOf(refused)).toBe('forbidden')
  })

  it('Accountant sees purchases with prices, and cannot change them', async () => {
    const got = ok(
      await shop.as<{ data: PurchaseDto; meta: { redacted: string[] } }>(
        team.accountant,
        'purchase.get',
        { id: purchase.id },
      ),
    )
    expect(got.meta.redacted).toEqual([])
    expect(got.data.total).toBe('13')
    expect(codeOf(await shop.as(team.accountant, 'purchase.reverse', { id: purchase.id }))).toBe(
      'forbidden',
    )
    expect(
      codeOf(await shop.as(team.accountant, 'supplier.create', { id: newId(), name: 'Nope' })),
    ).toBe('forbidden')
  })

  it('Sales, Supervisor and Employee cannot open purchases or suppliers', async () => {
    for (const template of ['sales', 'supervisor', 'employee'] as const) {
      for (const path of ['purchase.list', 'supplier.list', 'books.get']) {
        expect(codeOf(await shop.as(team[template], path)), `${template} ${path}`).toBe('forbidden')
      }
    }
  })
})
