import { randomBytes } from 'node:crypto'
import type { PurchaseDto } from '@bizcost/contracts'
import { compareDecimal, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import {
  callProcedure,
  createTenant,
  openApi,
  proceduresOf,
  queryInputOf,
  type Api,
  type Tenant,
} from './fixture'

// "Nothing shows stock" in M2 (ROADMAP.md M2 definition of done: capabilities hide stock quantities;
// Phase 4 brings stock screens). src/contract.test.ts checks that no output field is named like a
// stock quantity; this checks the values: a material whose stock on hand is a quantity no document
// holds (the fixture's purchase and return, then two more purchases of 3.1 L and 4.07 L), and every
// business query answered for the owner, who may see everything: no value in any answer is that stock,
// in base units or in the material's unit, for the business or for a location.

let api: Api
let tenant: Tenant

beforeAll(async () => {
  api = openApi()
  tenant = await createTenant(api, 'S')
  for (const qty of ['3.1', '4.07']) {
    const draft = await callProcedure<{ data: PurchaseDto }>(
      api.handler,
      { path: 'purchase.create', type: 'mutation' },
      tenant.owner.token,
      {
        businessId: tenant.id,
        input: {
          id: newId(),
          businessDate: tenant.purchase.businessDate,
          documentType: 'no_invoice',
          paymentMethod: 'cash',
          lines: [
            {
              kind: 'material',
              id: newId(),
              materialId: tenant.material.id,
              qty,
              unit: 'l',
              unitPrice: '13',
            },
          ],
        },
      },
    )
    expect(draft.error, draft.raw).toBeUndefined()
    const posted = await callProcedure(
      api.handler,
      { path: 'purchase.post', type: 'mutation' },
      tenant.owner.token,
      {
        businessId: tenant.id,
        input: { id: draft.data!.data.id, version: draft.data!.data.version },
      },
    )
    expect(posted.error, posted.raw).toBeUndefined()
  }
}, 120_000)

afterAll(async () => {
  await api.close()
})

/** Every string or number in a JSON answer. */
function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value))
  else if (Array.isArray(value)) for (const item of value) leaves(item, out)
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) leaves(item, out)
  return out
}

const isDecimal = (value: string) => /^-?\d+(?:\.\d+)?$/.test(value)

describe('no answer holds a stock quantity (M2: nothing shows stock)', () => {
  it('the stock of a material, its locations’ and in its unit, is in no business query’s answer', async () => {
    const stock = await api.admin<{ qty: string }[]>`
      select trim_scale(qty)::text as qty from app.material_costs
       where business_id = ${tenant.id} and material_id = ${tenant.material.id}
      union
      select trim_scale(qty)::text from app.stock_balances
       where business_id = ${tenant.id} and material_id = ${tenant.material.id} and qty <> 0
      union
      select trim_scale(c.qty / 1000)::text from app.material_costs c
       where c.business_id = ${tenant.id} and c.material_id = ${tenant.material.id}`
    const onHand = stock.map((row) => row.qty)
    // The premise: base units (ml) and litres, none of them 0, and not a quantity any document holds.
    expect(onHand.length).toBeGreaterThanOrEqual(2)
    expect(onHand.every((qty) => compareDecimal(qty, '0') > 0)).toBe(true)

    const queries = proceduresOf(appRouter).filter(
      (p) => p.base === 'business' && p.type === 'query',
    )
    const found: string[] = []
    for (const procedure of queries) {
      const result = await callProcedure(api.handler, procedure, tenant.owner.token, {
        businessId: tenant.id,
        input: queryInputOf(procedure.path, tenant),
      })
      expect(result.error, `${procedure.path}: ${result.raw}`).toBeUndefined()
      for (const leaf of leaves(result.data)) {
        if (!isDecimal(leaf)) continue
        if (onHand.some((qty) => compareDecimal(leaf, qty) === 0)) {
          found.push(`${procedure.path}: ${leaf}`)
        }
      }
    }
    expect(queries.length).toBeGreaterThan(40)
    expect(found).toEqual([])
  })
})

// M3 definition of done: "No sale or import is ever refused for stock. No answer holds a stock
// quantity, and the stock ledger is unchanged by sales." Every way a sale is finalized or taken back
// (a sale, an import, an order delivered and undone, an invoice issued from scratch and its credit
// note, a reversal), each selling a thousand times what is on hand: all served, none answers with a
// stock quantity, and the ledger (movements, balances, cost rows) is exactly as before.
describe('selling far more than is on hand: served, no stock in the answers, the ledger unchanged (M3)', () => {
  it('a sale, an import, an order, an invoice and its credit note, and their reversals', async () => {
    const run = async <T>(path: string, type: 'query' | 'mutation', input?: unknown) => {
      const result = await callProcedure<T>(api.handler, { path, type }, tenant.owner.token, {
        businessId: tenant.id,
        input,
      })
      expect(result.error, `${path}: ${result.raw}`).toBeUndefined()
      return result
    }
    const ledger = async () => {
      const [row] = await api.admin<{ h: string }[]>`
        select md5(concat_ws('#',
          (select string_agg(to_jsonb(m)::text, '|' order by m.id) from app.stock_movements m
            where m.business_id = ${tenant.id}),
          (select string_agg(to_jsonb(b)::text, '|' order by b.id) from app.stock_balances b
            where b.business_id = ${tenant.id}),
          (select string_agg(to_jsonb(c)::text, '|' order by c.id) from app.material_costs c
            where c.business_id = ${tenant.id}))) as h`
      return row?.h
    }
    const stock = await api.admin<{ qty: string }[]>`
      select trim_scale(qty)::text as qty from app.material_costs
       where business_id = ${tenant.id} and material_id = ${tenant.material.id}
      union
      select trim_scale(qty)::text from app.stock_balances
       where business_id = ${tenant.id} and material_id = ${tenant.material.id} and qty <> 0
      union
      select trim_scale(c.qty / 1000)::text from app.material_costs c
       where c.business_id = ${tenant.id} and c.material_id = ${tenant.material.id}`
    const onHand = stock.map((row) => row.qty)
    const before = await ledger()
    const found: string[] = []
    const noStockIn = (path: string, data: unknown) => {
      for (const leaf of leaves(data)) {
        if (isDecimal(leaf) && onHand.some((qty) => compareDecimal(leaf, qty) === 0)) {
          found.push(`${path}: ${leaf}`)
        }
      }
    }
    const today = tenant.sale.businessDate
    // A thousand lattes use 6,000 L of the material (half a carton of 12 L each): far beyond stock.
    const many = '1000'
    const item = () => ({
      kind: 'item',
      id: newId(),
      productId: tenant.product.id,
      qty: many,
      unitPrice: '1',
    })

    const draft = await run<{ data: { id: string; version: number } }>('sale.create', 'mutation', {
      id: newId(),
      source: 'single',
      businessDate: today,
      locationId: tenant.branch.id,
      channelId: tenant.channel.id,
      lines: [item()],
    })
    const sold = await run<{ data: { id: string } }>('sale.post', 'mutation', {
      id: draft.data!.data.id,
      version: draft.data!.data.version,
    })
    noStockIn('sale.post', sold.data)

    // An import in a channel of its own (the fixture's import covers today in its channel).
    const channel = await run<{ data: { id: string } }>('channel.create', 'mutation', {
      id: newId(),
      name: `Shop ${newId()}`,
      kind: 'shop',
    })
    const imported = await run<{ data: { id: string; version: number } }>(
      'saleImport.create',
      'mutation',
      {
        id: newId(),
        channelId: channel.data!.data.id,
        locationId: tenant.branch.id,
        fileName: 'many.csv',
        fileHash: randomBytes(32).toString('hex'),
        fingerprint: randomBytes(32).toString('hex'),
        shape: 'summary',
        periodFrom: today,
        periodTo: today,
        mapping: {
          headerRow: 0,
          columns: { name: 0, qty: 1, total: 2 },
          headers: {},
          dateOrder: 'dmy',
        },
        amountsIncludeVat: false,
        rowsRead: 1,
        rowsLeftOut: 0,
        rowCount: 1,
      },
    )
    await run('saleImport.addRows', 'mutation', {
      id: imported.data!.data.id,
      rows: [
        {
          position: 0,
          businessDate: today,
          name: tenant.product.name,
          qty: many,
          amount: many,
          fileRows: 1,
        },
      ],
    })
    const posted = await run<{ data: { status: string } }>('saleImport.post', 'mutation', {
      id: imported.data!.data.id,
      version: imported.data!.data.version,
    })
    expect(posted.data!.data.status).toBe('posted')
    noStockIn('saleImport.post', posted.data)

    const order = await run<{ data: { id: string; version: number } }>('order.create', 'mutation', {
      id: newId(),
      customerId: tenant.customer.id,
      businessDate: today,
      locationId: tenant.branch.id,
      channelId: tenant.channel.id,
      lines: [item()],
    })
    const delivered = await run<{ data: { id: string } }>('order.deliver', 'mutation', {
      id: order.data!.data.id,
      version: order.data!.data.version,
    })
    noStockIn('order.deliver', delivered.data)

    const invoiceDraft = await run<{ id: string; version: number }>('invoice.create', 'mutation', {
      id: newId(),
      customerId: tenant.customer.id,
      locationId: tenant.branch.id,
      channelId: tenant.channel.id,
      countedElsewhere: false,
      lines: [{ id: newId(), productId: tenant.product.id, qty: many, unitPrice: '1' }],
    })
    const invoice = await run<{ id: string; lines: { id: string }[] }>(
      'invoice.issue',
      'mutation',
      {
        id: invoiceDraft.data!.id,
        version: invoiceDraft.data!.version,
      },
    )
    noStockIn('invoice.issue', invoice.data)
    const noteDraft = await run<{ id: string; version: number }>('creditNote.create', 'mutation', {
      id: newId(),
      invoiceId: invoice.data!.id,
      eventDate: today,
      reason: 'goods_returned',
      reasonText: 'Returned',
      by: 'quantity',
      lines: [{ invoiceLineId: invoice.data!.lines[0]!.id, qty: '500' }],
    })
    const note = await run('creditNote.issue', 'mutation', {
      id: noteDraft.data!.id,
      version: noteDraft.data!.version,
    })
    noStockIn('creditNote.issue', note.data)

    noStockIn(
      'sale.reverse',
      (await run('sale.reverse', 'mutation', { id: sold.data!.data.id })).data,
    )
    noStockIn(
      'order.undoDelivery',
      (await run('order.undoDelivery', 'mutation', { id: delivered.data!.data.id })).data,
    )

    // The premise: the sale, the import, the order and the invoice each sold the thousand lattes, and
    // the credit note took 500 back (a reversal takes its sale back whole, with no line of its own).
    const [counted] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.sale_lines l
       where l.business_id = ${tenant.id} and l.product_id = ${tenant.product.id}
         and abs(l.qty) in (1000, 500)`
    expect(counted?.n).toBe(5)
    expect(found).toEqual([])
    expect(await ledger()).toBe(before)
  }, 120_000)
})
