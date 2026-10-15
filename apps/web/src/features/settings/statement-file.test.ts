import { describe, expect, it } from 'vitest'
import { columnName } from '../sales/import/column-name'
import { parseDelimited } from '../sales/import/read-file'
import { readStatementRows } from './statement-file'

// A channel's statements read from a file (M3 Step 4): each row left out says its row, its column
// and why, as the sales importer does (D-261).

describe('readStatementRows', () => {
  it('names the row, the column and why each row is left out', () => {
    const text = [
      'From,To,Sales,Commission,Payment fees,Payout',
      '01/08/2026,15/08/2026,"1,000.00",180.00,0,820.00',
      '16/08/2026,,500.00,90.00,0,410.00',
      '16/08/2026,32/08/2026,500.00,90.00,0,410.00',
      '20/08/2026,18/08/2026,500.00,90.00,0,410.00',
      '21/08/2026,31/08/2026,500.00,ninety,0,410.00',
    ].join('\n')
    const read = readStatementRows(parseDelimited(text, ','))
    expect(read.statements.map((s) => [s.row, s.periodFrom, s.periodTo, s.commission])).toEqual([
      [2, '2026-08-01', '2026-08-15', '180'],
    ])
    expect(read.errors).toEqual([
      { row: 3, column: 1, code: 'date_missing' },
      { row: 4, column: 1, code: 'date_invalid' },
      { row: 5, column: null, code: 'days_order' },
      { row: 6, column: 3, code: 'number_invalid' },
    ])
    expect(read.headers[1]).toBe('To')
  })
})

describe('columnName', () => {
  it('puts the letter first and the header after it, each in its own direction', () => {
    expect(columnName(4, 'الصنف')).toBe('\u2068E\u2069 (\u2068الصنف\u2069)')
    expect(columnName(1, undefined)).toBe('B')
  })
})
