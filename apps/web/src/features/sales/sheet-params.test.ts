import { describe, expect, it } from 'vitest'
import {
  daysFor,
  isPeriod,
  previousDay,
  readSheetParams,
  sheetDays,
  sheetHref,
  writeSheetParams,
} from './sheet-params'

// Which sheet Today's sales opens, kept in the address (M3 Step 2; Q9): never after today, several
// days only within one month, today and the defaults left out.

const TODAY = '2026-10-08'
const CHANNEL = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
const BRANCH = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f71'

describe('the sheet in the address', () => {
  it('reads today and no channel or branch from an empty address', () => {
    expect(readSheetParams(new URLSearchParams(), TODAY)).toEqual({
      businessDate: TODAY,
      periodFrom: null,
      channelId: null,
      locationId: null,
    })
  })

  it('never reads a day after today, or a malformed one, as anything but today', () => {
    expect(readSheetParams(new URLSearchParams('date=2026-10-09'), TODAY).businessDate).toBe(TODAY)
    expect(readSheetParams(new URLSearchParams('date=2026-13-01'), TODAY).businessDate).toBe(TODAY)
    expect(readSheetParams(new URLSearchParams('date=2026-10-07'), TODAY).businessDate).toBe(
      '2026-10-07',
    )
  })

  it('reads several days only within one month, before the last day', () => {
    const read = (query: string) => readSheetParams(new URLSearchParams(query), TODAY)
    expect(read('date=2026-09-30&from=2026-09-01').periodFrom).toBe('2026-09-01')
    // Across two months, or not before the last day: one day.
    expect(read('date=2026-10-02&from=2026-09-28').periodFrom).toBeNull()
    expect(read('date=2026-10-02&from=2026-10-02').periodFrom).toBeNull()
    expect(read('date=2026-10-02&from=2026-10-05').periodFrom).toBeNull()
  })

  it('reads ids in lowercase and ignores what is not one', () => {
    const read = readSheetParams(
      new URLSearchParams(`channel=${CHANNEL.toUpperCase()}&branch=nope`),
      TODAY,
    )
    expect(read.channelId).toBe(CHANNEL)
    expect(read.locationId).toBeNull()
  })

  it('writes only what differs from today and the defaults, and reads it back', () => {
    expect(
      writeSheetParams(
        { businessDate: TODAY, periodFrom: null, channelId: null, locationId: null },
        TODAY,
      ),
    ).toBe('')
    const period = {
      businessDate: '2026-09-30',
      periodFrom: '2026-09-01',
      channelId: CHANNEL,
      locationId: BRANCH,
    }
    const query = writeSheetParams(period, TODAY)
    expect(query).toBe(`date=2026-09-30&from=2026-09-01&channel=${CHANNEL}&branch=${BRANCH}`)
    expect(readSheetParams(new URLSearchParams(query), TODAY)).toEqual(period)
    expect(sheetHref('b1', period, TODAY)).toBe(`/b/b1/sales/today?${query}`)
    expect(sheetHref('b1', { ...period, businessDate: TODAY, periodFrom: null }, TODAY)).toBe(
      `/b/b1/sales/today?channel=${CHANNEL}&branch=${BRANCH}`,
    )
  })
})

describe('"These sales are for"', () => {
  it('says which choice a sheet is', () => {
    const base = { channelId: null, locationId: null }
    expect(sheetDays({ ...base, businessDate: TODAY, periodFrom: null }, TODAY)).toBe('today')
    expect(sheetDays({ ...base, businessDate: '2026-10-07', periodFrom: null }, TODAY)).toBe('day')
    expect(sheetDays({ ...base, businessDate: TODAY, periodFrom: '2026-10-01' }, TODAY)).toBe(
      'days',
    )
  })

  it('starts each choice on days it can be: yesterday, this month so far, last month on the 1st', () => {
    expect(daysFor('today', TODAY)).toEqual({ businessDate: TODAY, periodFrom: null })
    expect(daysFor('day', TODAY)).toEqual({ businessDate: '2026-10-07', periodFrom: null })
    expect(daysFor('days', TODAY)).toEqual({ businessDate: TODAY, periodFrom: '2026-10-01' })
    expect(daysFor('days', '2026-10-01')).toEqual({
      businessDate: '2026-09-30',
      periodFrom: '2026-09-01',
    })
    expect(daysFor('day', '2026-03-01')).toEqual({ businessDate: '2026-02-28', periodFrom: null })
  })

  it('knows the day before and a period of one month', () => {
    expect(previousDay('2026-01-01')).toBe('2025-12-31')
    expect(isPeriod('2026-02-01', '2026-02-28')).toBe(true)
    expect(isPeriod('2026-01-31', '2026-02-01')).toBe(false)
  })
})
