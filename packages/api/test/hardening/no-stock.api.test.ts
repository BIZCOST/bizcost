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
