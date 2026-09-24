import { sensitive, zDecimal } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appRouter, authedProcedure, businessProcedure, router } from '../src'
import { procedureContractViolations } from './contract'
import {
  addMember,
  connectApi,
  createBusiness,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  query,
  type TestUser,
} from './helpers'

// ATTACK (fixed, D-060): sensitivePaths()/sensitivityOf() did not look at (a) an object's .catchall()
// schema and (b) a field wrapped in z.lazy(). A sensitive() tag there was invisible: the value was
// served unredacted to any member, even from an authed (non-business) procedure and without
// withMeta(), and the contract test reported no violation.

const lineDto = z.object({ qty: zDecimal, unitCost: sensitive(zDecimal, 'cost') })
/** Lines keyed by id: a normal Zod idiom for a map with known extra keys. */
const byIdDto = z.object({}).catchall(lineDto)
const lazyFieldDto = z.object({ name: z.string(), cost: z.lazy(() => sensitive(zDecimal, 'cost')) })

const byId = { line1: { qty: '1', unitCost: '777.77' } }
const lazyItem = { name: 'Latte', cost: '888.88' }

const leakRouter = router({
  ...appRouter._def.record,
  leak: router({
    catchall: businessProcedure.output(byIdDto).query(() => byId),
    catchallOutsideBusiness: authedProcedure.output(byIdDto).query(() => byId),
    lazy: businessProcedure.output(lazyFieldDto).query(() => lazyItem),
  }),
})

let db: Db
let handler: ReturnType<typeof handlerFor>
let owner: TestUser
let employee: TestUser
let employeeToken: string
let businessId: string

beforeAll(async () => {
  db = connectApi()
  handler = handlerFor(db, leakRouter)
  ;[owner, employee] = await Promise.all([createUser(), createUser()])
  businessId = (await createBusiness(db, owner, 'Leak Test Cafe')).id
  await addMember(db, owner, businessId, employee, { template: 'employee' })
  employeeToken = await mintToken(employee)
})

afterAll(async () => {
  await Promise.all([owner, employee].map(deleteUser))
  await db.$client.end()
})

describe('sensitive tags the redactor cannot see', () => {
  it('the contract check flags sensitive fields under .catchall() and z.lazy()', () => {
    const violations = procedureContractViolations(leakRouter)
    expect(violations.some((v) => v.startsWith('leak.catchall:'))).toBe(true)
    expect(violations.some((v) => v.startsWith('leak.catchallOutsideBusiness:'))).toBe(true)
    expect(violations.some((v) => v.startsWith('leak.lazy:'))).toBe(true)
  })

  it('an employee (no data.cost.view) never receives a cost under .catchall()', async () => {
    const result = await query(handler, 'leak.catchall', {
      token: employeeToken,
      businessId,
    })
    expect(result.raw).not.toContain('777.77')
  })

  it('an authed (non-business) procedure never outputs a cost under .catchall()', async () => {
    const result = await query(handler, 'leak.catchallOutsideBusiness', {
      token: employeeToken,
    })
    expect(result.raw).not.toContain('777.77')
  })

  it('an employee never receives a cost field wrapped in z.lazy()', async () => {
    const result = await query(handler, 'leak.lazy', {
      token: employeeToken,
      businessId,
    })
    expect(result.raw).not.toContain('888.88')
  })
})
