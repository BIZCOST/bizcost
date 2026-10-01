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
  it('serves exactly the M1 procedures and those of M2 so far', () => {
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
      'costCategory.archive',
      'costCategory.create',
      'costCategory.list',
      'costCategory.unarchive',
      'costCategory.update',
      'dashboard.checklist',
      'expense.approve',
      'expense.correct',
      'expense.create',
      'expense.discard',
      'expense.get',
      'expense.getMine',
      'expense.list',
      'expense.mine',
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
      'member.permissions',
      'member.remove',
      'member.transferOwnership',
      'member.updatePermissions',
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
      'recipe.get',
      'recipe.save',
      'role.list',
      'role.updatePermissions',
      'runningCost.create',
      'runningCost.get',
      'runningCost.list',
      'runningCost.remove',
      'runningCost.update',
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
})

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
    expect([...new Set(numbers.map((leaf) => leaf.name))].sort()).toEqual([
      'limit',
      'questionSetVersion',
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
