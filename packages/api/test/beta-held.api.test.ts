import type { BusinessContextDto, CustomizationDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { MODULES } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  query,
  SECRET_KEY,
  type TestUser,
} from './helpers'
import { appCode, BAKER, setupBusiness, WORKSHOP } from './settings'
import { moduleRegistry } from '../src'

// BIZCOST_HELD_MODULES (D-350, D-359): a released module named there behaves as not available on that
// deployment, in the API's gates and the nav alike; the business's own switch is kept. Invoices first:
// quotations keep working, without "convert to invoice". The production build's pages: e2e beta.spec.ts.

const db = connectApi()
const held = handlerFor(db, undefined, {
  heldModules: ['invoices'],
  supabaseSecretKey: SECRET_KEY,
})
const open = handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY })

let user: TestUser
let token: string
let businessId: string

beforeAll(async () => {
  user = await createUser({ locale: 'en' })
  token = await mintToken(user)
  // Quotes as a way of selling: Quotations and Invoices on, in the business's own rows.
  businessId = await setupBusiness(open, token, WORKSHOP)
  const context = await query<BusinessContextDto>(open, 'business.context', { token, businessId })
  expect(context.data?.modules.map((m) => m.id)).toContain('invoices')
})

afterAll(async () => {
  await deleteUser(user)
  await db.$client.end()
})

describe('a module held back', () => {
  it('its procedures answer MODULE_DISABLED, the same business still has them elsewhere', async () => {
    for (const [path, call] of [
      ['invoice.list', query],
      ['creditNote.list', query],
      ['invoice.create', mutate],
      ['creditNote.create', mutate],
    ] as const) {
      expect(appCode(await call(held, path, { token, businessId, input: {} })), path).toBe(
        'module_disabled',
      )
    }
    expect(appCode(await query(open, 'invoice.list', { token, businessId, input: {} }))).not.toBe(
      'module_disabled',
    )
  })

  it('leaves the nav and the "+", and the member’s keys no longer reach it there', async () => {
    const context = await query<BusinessContextDto>(held, 'business.context', { token, businessId })
    const ids = context.data!.modules.map((m) => m.id)
    expect(ids).not.toContain('invoices')
    expect(ids).toContain('quotations')
    const entries = context.data!.modules.flatMap((m) => m.nav.map((entry) => entry.id))
    expect(entries).not.toContain('invoices')
    const actions = context.data!.modules.flatMap((m) => m.quickActions.map((a) => a.id))
    expect(actions).not.toContain('new_invoice')
  })

  it('quotations keep working: the list, a new one, the document settings', async () => {
    const list = await query(held, 'quotation.list', { token, businessId, input: {} })
    expect(list.error).toBeUndefined()
    const settings = await query(held, 'document.settings', { token, businessId })
    expect(settings.error).toBeUndefined()
  })

  it('a file on an invoice is refused, on any record of it', async () => {
    for (const entity of ['invoice', 'invoice_line']) {
      const result = await mutate(held, 'attachment.uploadUrl', {
        token,
        businessId,
        input: { entity, entityId: newId(), contentType: 'image/png' },
      })
      expect(appCode(result), entity).toBe('module_disabled')
    }
  })

  it('Customize marks it not available, and keeps the business’s switch', async () => {
    const customization = await query<CustomizationDto>(held, 'business.customization', {
      token,
      businessId,
    })
    const invoices = customization.data!.modules.find((m) => m.id === 'invoices')
    expect(invoices).toMatchObject({ availability: 'planned', enabled: true })
    // When the deployment releases it, it is on again: nothing was changed.
    const context = await query<BusinessContextDto>(open, 'business.context', { token, businessId })
    expect(context.data?.modules.map((m) => m.id)).toContain('invoices')
  })

  it('a business that does not have it never gets it from a held list', async () => {
    const other = await createUser({ locale: 'en' })
    const otherToken = await mintToken(other)
    try {
      const baker = await setupBusiness(open, otherToken, BAKER)
      const context = await query<BusinessContextDto>(held, 'business.context', {
        token: otherToken,
        businessId: baker,
      })
      expect(context.data?.modules.map((m) => m.id)).not.toContain('invoices')
    } finally {
      await deleteUser(other)
    }
  })
})

describe('moduleRegistry', () => {
  it('holds in production too, unlike the preview, and held wins over a preview', () => {
    const availability = (registry: readonly { id: string; availability: string }[], id: string) =>
      registry.find((m) => m.id === id)?.availability
    const production = moduleRegistry({ heldModules: ['invoices'] }, 'production')
    expect(availability(production, 'invoices')).toBe('planned')
    expect(availability(production, 'quotations')).toBe('released')
    const previewed = moduleRegistry(
      { heldModules: ['inventory'], previewModules: ['inventory'] },
      'development',
    )
    expect(availability(previewed, 'inventory')).toBe('planned')
    expect(moduleRegistry({}, 'production')).toBe(MODULES)
  })
})
