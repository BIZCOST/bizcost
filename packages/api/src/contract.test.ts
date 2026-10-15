import { sensitive, withMeta, zDecimal } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { procedureContractViolations } from '../test/contract'
import {
  DECIMAL_CANDIDATES,
  inputLeaves,
  inputSchemaOf,
  isDecimalLeaf,
  isNumberLeaf,
  parseLeaf,
  spell,
  type Schema,
} from '../test/hardening/schema'
import { appRouter } from './routers'
import { authedProcedure, businessProcedure, publicProcedure, router } from './trpc'

const costly = z.object({ name: z.string(), cost: sensitive(zDecimal, 'cost') })

describe('appRouter contract', () => {
  it('serves exactly the M1 and M2 procedures and those of M3 so far', () => {
    expect(Object.keys(appRouter._def.procedures).sort()).toEqual([
      'account.delete',
      'account.setLastBusiness',
      'account.updateProfile',
      'attachment.add',
      'attachment.list',
      'attachment.remove',
      'attachment.uploadUrl',
      'books.close',
      'books.get',
      'business.context',
      'business.createFromSetup',
      'business.customization',
      'business.customize',
      'business.logoUploadUrl',
      'business.profile',
      'business.removeLogo',
      'business.setDefaultLocale',
      'business.setLogo',
      'business.updateProfile',
      'channel.archive',
      'channel.create',
      'channel.list',
      'channel.unarchive',
      'channel.update',
      'channelStatement.create',
      'channelStatement.discard',
      'channelStatement.get',
      'channelStatement.list',
      'channelStatement.post',
      'channelStatement.reverse',
      'channelStatement.update',
      'costCategory.archive',
      'costCategory.create',
      'costCategory.list',
      'costCategory.unarchive',
      'costCategory.update',
      'customer.archive',
      'customer.create',
      'customer.get',
      'customer.list',
      'customer.pick',
      'customer.similar',
      'customer.unarchive',
      'customer.update',
      'customerPayment.list',
      'customerPayment.record',
      'customerPayment.recordMany',
      'customerPayment.reverse',
      'dashboard.cards',
      'dashboard.checklist',
      'expense.approve',
      'expense.correct',
      'expense.create',
      'expense.discard',
      'expense.get',
      'expense.getMine',
      'expense.list',
      'expense.mine',
      'expense.payableChannels',
      'expense.payableRunningCosts',
      'expense.payers',
      'expense.post',
      'expense.reject',
      'expense.reverse',
      'expense.settings',
      'expense.submit',
      'expense.update',
      'expense.updateSettings',
      'expensePayment.list',
      'expensePayment.record',
      'expensePayment.reverse',
      'health',
      'importProfile.list',
      'importProfile.remove',
      'invitation.accept',
      'invitation.create',
      'invitation.list',
      'invitation.preview',
      'invitation.resend',
      'invitation.revoke',
      'location.create',
      'location.list',
      'location.remove',
      'location.rename',
      'location.setDefault',
      'material.archive',
      'material.costs',
      'material.create',
      'material.get',
      'material.list',
      'material.quickCreate',
      'material.unarchive',
      'material.update',
      'me',
      'member.changeRole',
      'member.leave',
      'member.list',
      'member.locations',
      'member.permissions',
      'member.remove',
      'member.transferOwnership',
      'member.updateLocations',
      'member.updatePermissions',
      'order.cancel',
      'order.create',
      'order.deliver',
      'order.get',
      'order.list',
      'order.undoDelivery',
      'order.update',
      'payable.list',
      'payable.mine',
      'product.archive',
      'product.costs',
      'product.create',
      'product.get',
      'product.list',
      'product.unarchive',
      'product.update',
      'productCost.get',
      'productCost.list',
      'productCost.settings',
      'productCost.updateSettings',
      'profit.summary',
      'purchase.correct',
      'purchase.create',
      'purchase.discard',
      'purchase.get',
      'purchase.list',
      'purchase.payers',
      'purchase.post',
      'purchase.reverse',
      'purchase.update',
      'purchasePayment.list',
      'purchasePayment.record',
      'purchasePayment.reverse',
      'purchaseReturn.create',
      'purchaseReturn.discard',
      'purchaseReturn.get',
      'purchaseReturn.list',
      'purchaseReturn.post',
      'purchaseReturn.reverse',
      'purchaseReturn.update',
      'receivable.list',
      'recipe.get',
      'recipe.save',
      'role.list',
      'role.updatePermissions',
      'runningCost.create',
      'runningCost.get',
      'runningCost.list',
      'runningCost.remove',
      'runningCost.update',
      'sale.correct',
      'sale.create',
      'sale.daySheet',
      'sale.discard',
      'sale.fillDeliveryCost',
      'sale.get',
      'sale.list',
      'sale.post',
      'sale.refund',
      'sale.reverse',
      'sale.update',
      'saleImport.addRows',
      'saleImport.create',
      'saleImport.discard',
      'saleImport.get',
      'saleImport.list',
      'saleImport.match',
      'saleImport.post',
      'saleImport.reverse',
      'saleImport.setOverlap',
      'supplier.archive',
      'supplier.create',
      'supplier.get',
      'supplier.list',
      'supplier.unarchive',
      'supplier.update',
    ])
  })

  it('every procedure has a Zod output, runs redact, and keeps sensitive fields in business envelopes', () => {
    expect(procedureContractViolations(appRouter)).toEqual([])
  })

  // What customers owe (M3 Step 5, A2): one figure per obligation, named `owed`; no answer carries a
  // field named `balance` (a running balance is not what BizCost keeps).
  it('has no output field named balance', () => {
    const named: string[] = []
    const owedIn = new Set<string>()
    for (const path of Object.keys(appRouter._def.procedures)) {
      const procedure = (
        appRouter._def.procedures as unknown as Record<string, { _def: { output?: unknown } }>
      )[path]
      walkKeys(procedure?._def.output, (key) => {
        if (/^balance$/i.test(key)) named.push(path)
        if (key === 'owed') owedIn.add(path)
      })
    }
    expect(named).toEqual([])
    // The walk reaches the nested figures (it is not vacuous).
    expect([...owedIn]).toEqual(
      expect.arrayContaining(['receivable.list', 'order.get', 'customerPayment.record']),
    )
  })
})

/** Calls `visit` with every object key of a Zod schema, however deep (wrappers, arrays, unions). */
function walkKeys(schema: unknown, visit: (key: string) => void, seen = new Set<unknown>()): void {
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return
  seen.add(schema)
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def
  if (!def) return
  const shape = def.shape as Record<string, unknown> | undefined
  if (shape) {
    for (const [key, field] of Object.entries(shape)) {
      visit(key)
      walkKeys(field, visit, seen)
    }
  }
  for (const inner of [def.innerType, def.element, def.in, def.out, def.valueType, def.catchall]) {
    walkKeys(inner, visit, seen)
  }
  for (const option of (def.options as unknown[] | undefined) ?? []) walkKeys(option, visit, seen)
  for (const side of [def.left, def.right]) walkKeys(side, visit, seen)
  if (typeof def.getter === 'function') walkKeys((def.getter as () => unknown)(), visit, seen)
}

// Every quantity and price field accepts Arabic-Indic digits, and no number is a float (ROADMAP.md
// M2 definition of done). Every input field of every procedure is walked (test/hardening/schema.ts):
// a field that reads numbers and refuses words is a decimal field; each must read the same number
// in ASCII, Arabic-Indic (with ٫) and Eastern Arabic-Indic digits, and refuse a JSON number. The only
// number fields are whole counters. A field added with its own number schema fails here.
describe('numbers a client sends', () => {
  const leaves = Object.keys(appRouter._def.procedures).flatMap((path) => {
    const schema = inputSchemaOf(appRouter, path)
    return (schema ? inputLeaves(schema) : []).map((leaf) => ({
      ...leaf,
      at: `${path} ${leaf.path}`,
    }))
  })
  const decimals = leaves.filter((leaf) => isDecimalLeaf(leaf.schema))
  const numbers = leaves.filter((leaf) => isNumberLeaf(leaf.schema))

  it('the walk finds the quantity and price fields', () => {
    expect(decimals.map((leaf) => leaf.at)).toEqual(
      expect.arrayContaining([
        'material.create packs.*.qty',
        'material.update crossFactors.*.qty',
        'product.create defaultPrice',
        'product.update ownerMinutes',
        'product.create resale.packs.*.qty',
        'recipe.save lines.*.qty',
        'recipe.save yieldQty',
        'purchase.create lines.*.qty',
        'purchase.create lines.*.unitPrice',
        'purchase.create lines.*.discount.percent',
        'purchase.update discount.amount',
        'purchase.update lines.*.vatRate',
        'purchaseReturn.create lines.*.amount',
        'purchaseReturn.update splitAmount',
        'purchasePayment.record amount',
        'expense.create amount',
        'expense.update vatRate',
        'expensePayment.record amount',
        'runningCost.update amount',
        'productCost.updateSettings ownerHourlyRate',
        'channel.create feePercent',
        'channel.update feePercent',
        'sale.create lines.*.qty',
        'sale.create lines.*.unitPrice',
        'sale.create lines.*.amount',
        'sale.create lines.*.discount.percent',
        'sale.update lines.*.discount.amount',
        'sale.update deliveryCost',
        'sale.fillDeliveryCost deliveryCost',
      ]),
    )
  })

  it.each(['arabic', 'eastern'] as const)(
    'every decimal field reads %s digits as the same number',
    (digits) => {
      const misread: string[] = []
      for (const leaf of decimals) {
        for (const candidate of DECIMAL_CANDIDATES) {
          const ascii = parseLeaf(leaf.schema, candidate)
          if (!ascii.ok) continue
          const spelled = parseLeaf(leaf.schema, spell(candidate, digits))
          if (!spelled.ok || spelled.value !== ascii.value) {
            misread.push(`${leaf.at}: ${spell(candidate, digits)}`)
          }
        }
      }
      expect(decimals.length).toBeGreaterThan(30)
      expect(misread).toEqual([])
    },
  )

  it('no decimal field takes a JSON number', () => {
    const taken = decimals.flatMap((leaf) =>
      [1, 12, 0.5, 1.5].filter((n) => parseLeaf(leaf.schema, n).ok).map((n) => `${leaf.at}: ${n}`),
    )
    expect(taken).toEqual([])
  })

  it('the only number fields are whole counters, never a quantity or price', () => {
    // M3 Step 4: an import's counts, its rows' positions and the file's columns and rows (whole).
    expect([...new Set(numbers.map((leaf) => leaf.name))].sort()).toEqual([
      'column',
      'columns',
      'fileRows',
      'headerRow',
      'limit',
      'position',
      'questionSetVersion',
      'row',
      'rowCount',
      'rowsLeftOut',
      'rowsRead',
      'version',
    ])
    expect(numbers.filter((leaf) => parseLeaf(leaf.schema, 1.5).ok).map((l) => l.at)).toEqual([])
  })
})

// "Capabilities hide … stock quantities where they don't apply" (M2 definition of done): in M2 the
// ledger records stock, but nothing shows it (stock screens and counts are Phase 4, with keeps_stock).
// Every output field of every procedure is walked: none is a stock quantity.
describe('no procedure outputs a stock quantity', () => {
  it('no output field is named for stock on hand or a balance', () => {
    const outputs = Object.entries(
      appRouter._def.procedures as unknown as Record<string, { _def: { output?: unknown } }>,
    ).flatMap(([path, procedure]) =>
      inputLeaves(procedure._def.output as Schema).map((leaf) => `${path} ${leaf.path}`),
    )
    expect(outputs.length).toBeGreaterThan(500)
    expect(outputs.filter((at) => /stock|on_?hand|balance/i.test(at))).toEqual([])
  })
})

describe('procedureContractViolations', () => {
  it('reports a procedure without .output()', () => {
    const bad = router({ noOutput: publicProcedure.query(() => 'x') })
    expect(procedureContractViolations(bad)).toEqual(['noOutput: has no Zod .output() schema'])
  })

  it('reports sensitive fields outside a business procedure', () => {
    const bad = router({
      leak: authedProcedure.output(withMeta(costly)).query(() => ({
        data: { name: 'x', cost: '1' },
        meta: { redacted: [] },
      })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'leak: outputs sensitive fields but is not a business procedure',
    ])
  })

  it('reports sensitive fields without the withMeta envelope', () => {
    const bad = router({
      bare: businessProcedure.output(costly).query(() => ({ name: 'x', cost: '1' })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'bare: outputs sensitive fields without the withMeta() envelope',
    ])
  })

  it('reports a sensitive tag the redactor cannot apply', () => {
    const bad = router({
      list: businessProcedure
        .output(withMeta(z.object({ prices: z.array(sensitive(zDecimal, 'cost')) })))
        .query(() => ({ data: { prices: [] }, meta: { redacted: [] } })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'list: SensitiveSchemaError: sensitive() must tag an object field; found one on prices.*',
    ])
  })

  it('reports sensitive fields hidden under .catchall() or z.lazy()', () => {
    const line = z.object({ unitCost: sensitive(zDecimal, 'cost') })
    const bad = router({
      byId: businessProcedure.output(z.object({}).catchall(line)).query(() => ({})),
      lazy: authedProcedure
        .output(z.object({ cost: z.lazy(() => sensitive(zDecimal, 'cost')) }))
        .query(() => ({})),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'byId: outputs sensitive fields without the withMeta() envelope',
      'lazy: outputs sensitive fields but is not a business procedure',
      'lazy: outputs sensitive fields without the withMeta() envelope',
    ])
  })

  it('reports untyped outputs, which could carry any column', () => {
    const bad = router({
      raw: businessProcedure.output(z.object({ row: z.unknown() })).query(() => ({ row: 1 })),
      loose: publicProcedure.output(z.looseObject({ id: z.string() })).query(() => ({ id: 'x' })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'raw: SensitiveSchemaError: untyped output (unknown) at row: every output value needs a typed schema',
      'loose: SensitiveSchemaError: untyped output (unknown) at *: every output value needs a typed schema',
    ])
  })

  it('accepts a business procedure that returns sensitive fields in withMeta', () => {
    const good = router({
      item: businessProcedure
        .output(withMeta(costly))
        .query(() => ({ data: { name: 'x', cost: '1' }, meta: { redacted: [] } })),
    })
    expect(procedureContractViolations(good)).toEqual([])
  })
})
