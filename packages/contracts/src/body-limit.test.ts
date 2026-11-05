import { describe, expect, it } from 'vitest'
import { IMPORT_CODE_MAX_LENGTH, IMPORT_NAME_MAX_LENGTH, IMPORT_ROWS_CHUNK } from './sales'
import { addImportRowsInput } from './dto/imports'
import {
  QUOTATION_AREA_MAX_LENGTH,
  QUOTATION_LINE_DETAILS_MAX_LENGTH,
  QUOTATION_LINE_NOTE_MAX_LENGTH,
  QUOTATION_LINE_TITLE_MAX_LENGTH,
  QUOTATION_LINES_MAX,
} from './documents'

// A Vercel function takes a request body of at most 4.5 MB (D-353; files go straight to Storage, never
// through it). The largest inputs of the API, at their limits, in the widest ordinary text there is: a
// three-byte letter in every place (Arabic is two). A limit raised past this fails here, not on the
// first big import of a real business, where it would be a bare 413 from the platform.
const VERCEL_BODY_LIMIT_BYTES = 4.5 * 1000 * 1000
const WIDE = 'ॐ'
const ID = '0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e6f'
/** The JSON's UTF-8 length (this package has neither Node's nor the browser's types). */
const bytes = (value: unknown) => {
  let total = 0
  for (const character of JSON.stringify(value)) {
    const code = character.codePointAt(0) ?? 0
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return total
}

describe('the largest requests fit a hosted function', () => {
  it('a full chunk of an import, sent as one call', () => {
    const rows = Array.from({ length: IMPORT_ROWS_CHUNK }, (_, position) => ({
      position: 90_000 + position,
      businessDate: '2026-11-04',
      name: WIDE.repeat(IMPORT_NAME_MAX_LENGTH),
      code: WIDE.repeat(IMPORT_CODE_MAX_LENGTH),
      qty: '12345678.123456',
      amount: '1234567890.12',
      refunds: '1234567890.12',
      fileRows: 100_000,
    }))
    const input = { id: ID, rows }
    expect(addImportRowsInput.safeParse(input).success).toBe(true)
    expect(bytes(input)).toBeLessThan(VERCEL_BODY_LIMIT_BYTES)
  })

  it('a quotation of the most lines, each with every text at its longest', () => {
    const lines = Array.from({ length: QUOTATION_LINES_MAX }, () => ({
      id: ID,
      productId: ID,
      area: WIDE.repeat(QUOTATION_AREA_MAX_LENGTH),
      title: WIDE.repeat(QUOTATION_LINE_TITLE_MAX_LENGTH),
      details: WIDE.repeat(QUOTATION_LINE_DETAILS_MAX_LENGTH),
      note: WIDE.repeat(QUOTATION_LINE_NOTE_MAX_LENGTH),
      qty: '12345678.123456',
      unit: 'piece',
      unitPrice: '1234567890.12',
    }))
    expect(bytes({ lines })).toBeLessThan(VERCEL_BODY_LIMIT_BYTES)
  })
})
