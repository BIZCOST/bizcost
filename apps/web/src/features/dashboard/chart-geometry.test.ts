import { describe, expect, it } from 'vitest'
import { chartLayout, dayAt, labelledDays, niceScale } from './chart-geometry'

const BOX = { width: 340, height: 200, start: 40, end: 0, top: 10, bottom: 30, rtl: false }

describe('the axis of "Sales and real profit by day"', () => {
  it('holds every value and 0, in round steps', () => {
    expect(niceScale([3600, 4100, 2950])).toEqual({
      min: 0,
      max: 5000,
      step: 1000,
      ticks: [0, 1000, 2000, 3000, 4000, 5000],
    })
    // A day at a loss goes below 0.
    expect(niceScale([900, -120]).ticks).toEqual([-250, 0, 250, 500, 750, 1000])
    expect(niceScale([18]).ticks).toEqual([0, 5, 10, 15, 20])
    expect(niceScale([0.3]).ticks).toEqual([0, 0.1, 0.2, 0.3])
  })

  it('shows 0 to 1 when there is nothing to show', () => {
    expect(niceScale([0, 0])).toMatchObject({ min: 0, max: 1 })
    expect(niceScale([])).toMatchObject({ min: 0, max: 1 })
  })
})

describe('where the days go', () => {
  const points = [
    { sales: 1000, profit: 400 },
    { sales: 0, profit: 0 },
    { sales: 500, profit: -100 },
  ]

  it('the first day at the start of the page: the left in English, the right in Arabic', () => {
    const ltr = chartLayout(points, BOX)
    const rtl = chartLayout(points, { ...BOX, rtl: true })
    expect(ltr.left).toBe(40)
    expect(ltr.right).toBe(340)
    expect(ltr.days.map((d) => d.x)).toEqual([90, 190, 290])
    // Mirrored: the axis' labels at the right, the first day next to them.
    expect(rtl.left).toBe(0)
    expect(rtl.right).toBe(300)
    expect(rtl.days.map((d) => d.x)).toEqual([250, 150, 50])
    expect(rtl.labelX).toBeGreaterThan(rtl.right)
    expect(ltr.labelX).toBeLessThan(ltr.left)
  })

  it('columns grow from the 0 line, at most 24px wide; profit below 0 goes under it', () => {
    const layout = chartLayout(points, BOX)
    const [first, empty, third] = layout.days
    expect(first!.barWidth).toBe(24)
    expect(first!.barY + first!.barHeight).toBeCloseTo(layout.zeroY)
    expect(empty!.barHeight).toBe(0)
    expect(third!.profitY!).toBeGreaterThan(layout.zeroY)
    expect(first!.profitY!).toBeLessThan(layout.zeroY)
  })

  it('without profit shown, the columns only', () => {
    const layout = chartLayout([{ sales: 100, profit: null }], BOX)
    expect(layout.days[0]!.profitY).toBeNull()
  })

  it('finds the day under the pointer, mirrored in Arabic', () => {
    const ltr = chartLayout(points, BOX)
    const rtl = chartLayout(points, { ...BOX, rtl: true })
    expect(dayAt(ltr, 95, false)).toBe(0)
    expect(dayAt(ltr, 300, false)).toBe(2)
    expect(dayAt(ltr, 20, false)).toBeNull()
    expect(dayAt(rtl, 260, true)).toBe(0)
    expect(dayAt(rtl, 10, true)).toBe(2)
  })

  it('writes the 1st and every 7th day under the axis, and the last when there is room', () => {
    expect(labelledDays(31)).toEqual([0, 7, 14, 21, 28])
    expect(labelledDays(30)).toEqual([0, 7, 14, 21, 28])
    expect(labelledDays(5)).toEqual([0, 4])
    expect(labelledDays(1)).toEqual([0])
    expect(labelledDays(0)).toEqual([])
  })
})
