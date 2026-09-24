// Independent spec test for @bizcost/contracts (docs/ROADMAP.md Step 2), written from the
// specification only (docs/ARCHITECTURE.md §API & request flow, §Permissions (Redaction),
// §Numbers; docs/DECISIONS.md D-026, D-032, D-035).
import { newId, SENSITIVITY_CATEGORIES } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  APP_ERROR_CODES,
  appErrorI18nKey,
  sensitive,
  sensitivityRegistry,
  withMeta,
  zBusinessDate,
  zDecimal,
  zUuid,
} from './index'

const V4_UUID = '3b241101-e2bb-4255-8caf-4136c566a962'

// ---------------------------------------------------------------------------------------------
// zDecimal: decimal strings on the wire, never JS numbers
// ---------------------------------------------------------------------------------------------

describe('zDecimal', () => {
  it('accepts plain decimal strings and returns them unchanged', () => {
    for (const value of ['0', '7', '100', '12.500', '0.000001', '0.1']) {
      expect(zDecimal.parse(value)).toBe(value)
    }
  })

  it('keeps full precision (no float round-trip)', () => {
    // 28 significant digits: fits numeric(28,12), far beyond what a double can hold.
    const value = '1234567890123456.123456789012'
    expect(zDecimal.parse(value)).toBe(value)
  })

  it('always outputs a string', () => {
    expect(typeof zDecimal.parse('12.5')).toBe('string')
    expect(typeof zDecimal.parse('١٢')).toBe('string')
  })

  it('normalizes Arabic-Indic digits and the Arabic decimal separator ٫', () => {
    expect(zDecimal.parse('١٢٫٥')).toBe('12.5')
    expect(zDecimal.parse('١٢.٥')).toBe('12.5')
    expect(zDecimal.parse('١٠٠')).toBe('100')
    expect(zDecimal.parse('١٢٫٥٠٠')).toBe('12.500')
    expect(zDecimal.parse('1٢.5')).toBe('12.5')
  })

  it('normalizes Extended Arabic-Indic (Persian) digits', () => {
    expect(zDecimal.parse('۱۲٫۵')).toBe('12.5')
    expect(zDecimal.parse('۰')).toBe('0')
  })

  it('rejects JS numbers, including floats, NaN and Infinity', () => {
    for (const value of [12, 12.5, 0.1, 0, Number.NaN, Infinity, -Infinity]) {
      expect(zDecimal.safeParse(value).success).toBe(false)
    }
  })

  it('rejects other non-string values', () => {
    for (const value of [10n, null, undefined, true, {}, ['12'], new Date()]) {
      expect(zDecimal.safeParse(value).success).toBe(false)
    }
  })

  it('rejects exponent notation', () => {
    for (const value of ['1e5', '1E5', '1.5e-3', '2e+2', '١e٥']) {
      expect(zDecimal.safeParse(value).success).toBe(false)
    }
  })

  it('rejects NaN/Infinity spelled as strings', () => {
    for (const value of ['NaN', 'Infinity', '-Infinity', 'infinity']) {
      expect(zDecimal.safeParse(value).success).toBe(false)
    }
  })

  it('rejects garbage', () => {
    for (const value of [
      '',
      ' ',
      'abc',
      '12abc',
      'abc12',
      '0x1A',
      '1.2.3',
      '12..5',
      '١٢٫٥٫٣',
      '12,5',
      '--5',
      '5-',
      'AED 12',
      '12 AED',
    ]) {
      expect(zDecimal.safeParse(value).success).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// zUuid
// ---------------------------------------------------------------------------------------------

describe('zUuid', () => {
  it('accepts UUIDv7 ids from newId() and canonical UUIDs', () => {
    const id = newId()
    expect(zUuid.parse(id)).toBe(id)
    expect(zUuid.parse(V4_UUID)).toBe(V4_UUID)
  })

  it('rejects anything else', () => {
    for (const value of [
      '',
      'not-a-uuid',
      V4_UUID.replace(/-/g, ''),
      `${V4_UUID}' or 1=1`,
      ` ${V4_UUID}`,
      `${V4_UUID}x`,
      42,
      null,
      undefined,
    ]) {
      expect(zUuid.safeParse(value).success).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// zBusinessDate: YYYY-MM-DD local business day, stays a string
// ---------------------------------------------------------------------------------------------

describe('zBusinessDate', () => {
  it('accepts real calendar dates and returns the same string', () => {
    for (const value of ['2026-09-25', '2026-01-01', '2026-12-31', '2024-02-29', '2000-02-29']) {
      expect(zBusinessDate.parse(value)).toBe(value)
    }
  })

  it('rejects dates that do not exist', () => {
    for (const value of [
      '2026-02-30',
      '2025-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-09-00',
      '2026-09-32',
    ]) {
      expect(zBusinessDate.safeParse(value).success).toBe(false)
    }
  })

  it('rejects other formats and types', () => {
    for (const value of [
      '2026-9-25',
      '26-09-25',
      '2026/09/25',
      '20260925',
      '25-09-2026',
      '2026-09-25T00:00:00Z',
      '2026-09-25 ',
      '',
      'today',
      new Date('2026-09-25T00:00:00Z'),
      20260925,
      null,
    ]) {
      expect(zBusinessDate.safeParse(value).success).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// sensitive(): tags a schema with a sensitivity category in a dedicated registry
// ---------------------------------------------------------------------------------------------

describe('sensitive', () => {
  it('keeps the validation of the wrapped schema', () => {
    const unitCost = sensitive(zDecimal, 'cost')
    expect(unitCost.parse('12.5')).toBe('12.5')
    expect(unitCost.safeParse(12.5).success).toBe(false)
  })

  it('records the category in the sensitivity registry', () => {
    for (const category of SENSITIVITY_CATEGORIES) {
      const tagged = sensitive(zDecimal, category)
      expect(sensitivityRegistry.get(tagged)).toMatchObject({ category })
    }
  })

  it('does not tag the shared base schema or unrelated schemas', () => {
    sensitive(zDecimal, 'cost')
    sensitive(zDecimal, 'payroll')
    expect(sensitivityRegistry.get(zDecimal)).toBeUndefined()
    expect(sensitivityRegistry.get(z.string())).toBeUndefined()
  })

  it('keeps tags on the same base schema independent', () => {
    const cost = sensitive(zDecimal, 'cost')
    const supplierPrice = sensitive(zDecimal, 'supplier_price')
    expect(sensitivityRegistry.get(cost)).toMatchObject({ category: 'cost' })
    expect(sensitivityRegistry.get(supplierPrice)).toMatchObject({ category: 'supplier_price' })
  })

  it('is readable per field of an object schema', () => {
    const product = z.object({
      id: zUuid,
      name: z.string(),
      price: zDecimal,
      unitCost: sensitive(zDecimal, 'cost'),
      margin: sensitive(zDecimal, 'profit_margin'),
    })
    expect(sensitivityRegistry.get(product.shape.unitCost)).toMatchObject({ category: 'cost' })
    expect(sensitivityRegistry.get(product.shape.margin)).toMatchObject({
      category: 'profit_margin',
    })
    expect(sensitivityRegistry.get(product.shape.id)).toBeUndefined()
    expect(sensitivityRegistry.get(product.shape.name)).toBeUndefined()
    expect(sensitivityRegistry.get(product.shape.price)).toBeUndefined()
  })

  it('keeps the tag when docs metadata is chained after it', () => {
    const described = sensitive(zDecimal, 'cost').describe('Unit cost')
    const withDocs = sensitive(zDecimal, 'payroll').meta({ description: 'Salary' })
    expect(sensitivityRegistry.get(described)).toMatchObject({ category: 'cost' })
    expect(sensitivityRegistry.get(withDocs)).toMatchObject({ category: 'payroll' })
  })

  it('only accepts known sensitivity categories (type level)', () => {
    const tagUnknown = () => {
      // @ts-expect-error 'salary' is not a sensitivity category
      return sensitive(zDecimal, 'salary')
    }
    expect(typeof tagUnknown).toBe('function')
  })
})

// ---------------------------------------------------------------------------------------------
// withMeta(): { data, meta: { redacted: string[] } } envelope for outputs with sensitive fields
// ---------------------------------------------------------------------------------------------

describe('withMeta', () => {
  const Item = z.object({ id: zUuid, name: z.string() })
  const Envelope = withMeta(Item)
  const item = { id: newId(), name: 'Flour' }

  it('has exactly data and meta, with data being the given schema', () => {
    expect(Object.keys(Envelope.shape).sort()).toEqual(['data', 'meta'])
    expect(Envelope.shape.data).toBe(Item)
  })

  it('accepts an empty and a filled redacted list', () => {
    expect(Envelope.parse({ data: item, meta: { redacted: [] } })).toEqual({
      data: item,
      meta: { redacted: [] },
    })
    const redacted = ['unitCost', 'items.0.unitCost', 'lines.3.margin']
    expect(Envelope.parse({ data: item, meta: { redacted } }).meta.redacted).toEqual(redacted)
  })

  it('requires meta.redacted to be a list of strings', () => {
    expect(Envelope.safeParse({ data: item }).success).toBe(false)
    expect(Envelope.safeParse({ data: item, meta: {} }).success).toBe(false)
    expect(Envelope.safeParse({ data: item, meta: { redacted: 'unitCost' } }).success).toBe(false)
    expect(Envelope.safeParse({ data: item, meta: { redacted: [1] } }).success).toBe(false)
  })

  it('validates data with the wrapped schema', () => {
    expect(Envelope.safeParse({ meta: { redacted: [] } }).success).toBe(false)
    expect(
      Envelope.safeParse({ data: { id: 'x', name: 'Flour' }, meta: { redacted: [] } }).success,
    ).toBe(false)
  })

  it('strips unknown keys (Zod object semantics)', () => {
    const parsed = Envelope.parse({
      data: { ...item, secret: '1' },
      meta: { redacted: [], extra: true },
      extra: true,
    })
    expect(parsed).toEqual({ data: item, meta: { redacted: [] } })
  })

  it('wraps list outputs too', () => {
    const ListEnvelope = withMeta(z.array(Item))
    expect(ListEnvelope.parse({ data: [item, item], meta: { redacted: [] } }).data).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------------------------

describe('APP_ERROR_CODES', () => {
  const EXPECTED = [
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'validation',
    'module_disabled',
    'app_version_unsupported',
    'rate_limited',
    'internal',
  ]

  it('lists exactly the specified codes, without duplicates', () => {
    expect([...APP_ERROR_CODES].sort()).toEqual([...EXPECTED].sort())
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length)
  })

  it('maps every code to the i18n key errors.<code>', () => {
    for (const code of APP_ERROR_CODES) {
      expect(appErrorI18nKey(code)).toBe(`errors.${code}`)
    }
  })
})
