// The geometry of "Sales and real profit by day" (M3 Step 3, Q14: one chart drawn by BizCost, no chart
// library): a column per day for the sales and a line for the real profit on one shared axis in the
// business currency (never two scales), from the first day of the month at the page's start (the
// left in English, the right in Arabic). Amounts arrive as decimal strings; they become numbers here
// only to place marks on the screen (the figures shown are always the strings, formatted).

/** Round steps of an axis (1, 2, 2.5 or 5 × a power of ten), each up to where the next is nearer. */
const STEPS = [
  { below: 1.5, step: 1 },
  { below: 2.25, step: 2 },
  { below: 3.5, step: 2.5 },
  { below: 7.5, step: 5 },
]

export interface Scale {
  readonly min: number
  readonly max: number
  readonly step: number
  /** The axis' values, from the lowest up, 0 among them. */
  readonly ticks: readonly number[]
}

/**
 * An axis that holds every value and 0 with about `count` round steps: a day without sales sits on 0,
 * and a day at a loss goes below it. Nothing to show (every value 0) gives 0 to 1.
 */
export function niceScale(values: readonly number[], count = 4): Scale {
  const low = Math.min(0, ...values)
  const high = Math.max(0, ...values)
  if (high - low === 0) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] }
  const raw = (high - low) / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = (STEPS.find((s) => raw / power < s.below)?.step ?? 10) * power
  const min = Math.floor(low / step + 1e-9) * step
  const max = Math.ceil(high / step - 1e-9) * step
  const ticks: number[] = []
  for (let value = min; value <= max + step / 2; value += step) ticks.push(round(value, step))
  return { min, max, step, ticks }
}

/** A tick without the float's tail (0.30000000000000004 → 0.3), to the step's own decimals. */
function round(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export interface ChartBox {
  readonly width: number
  readonly height: number
  /** Room for the axis' labels at the page's start side, and the other margins. */
  readonly start: number
  readonly end: number
  readonly top: number
  readonly bottom: number
  /** Arabic: the first day at the right. */
  readonly rtl: boolean
}

export interface DayMark {
  readonly index: number
  /** The day's center across. */
  readonly x: number
  /** Its sales column: from the 0 line to its value (top-down, so `y` is the upper edge). */
  readonly barX: number
  readonly barY: number
  readonly barWidth: number
  readonly barHeight: number
  /** Its profit point (null: profit not shown). */
  readonly profitY: number | null
}

export interface ChartLayout {
  readonly scale: Scale
  readonly days: readonly DayMark[]
  /** The 0 line, and each tick's height. */
  readonly zeroY: number
  readonly ticks: readonly { readonly value: number; readonly y: number }[]
  /** The plot's edges across (left and right on the screen). */
  readonly left: number
  readonly right: number
  /** Where the axis' labels go across, and the width of one day. */
  readonly labelX: number
  readonly band: number
}

/** Columns are at most 24px wide and leave air between them (the band's rest). */
const MAX_BAR = 24

/** Where each day's column and profit point go. */
export function chartLayout(
  points: readonly { readonly sales: number; readonly profit: number | null }[],
  box: ChartBox,
): ChartLayout {
  const values = points.flatMap((p) => (p.profit === null ? [p.sales] : [p.sales, p.profit]))
  const scale = niceScale(values)
  const left = box.rtl ? box.end : box.start
  const right = box.width - (box.rtl ? box.start : box.end)
  const plotTop = box.top
  const plotBottom = box.height - box.bottom
  const yOf = (value: number) =>
    plotBottom - ((value - scale.min) / (scale.max - scale.min)) * (plotBottom - plotTop)
  const zeroY = yOf(0)
  const band = points.length > 0 ? (right - left) / points.length : right - left
  const barWidth = Math.max(2, Math.min(MAX_BAR, band * 0.62))
  const days = points.map((point, index) => {
    const offset = band * (index + 0.5)
    const x = box.rtl ? right - offset : left + offset
    const y = yOf(point.sales)
    return {
      index,
      x,
      barX: x - barWidth / 2,
      barY: Math.min(y, zeroY),
      barWidth,
      barHeight: Math.abs(zeroY - y),
      profitY: point.profit === null ? null : yOf(point.profit),
    }
  })
  return {
    scale,
    days,
    zeroY,
    ticks: scale.ticks.map((value) => ({ value, y: yOf(value) })),
    left,
    right,
    labelX: box.rtl ? right + 8 : left - 8,
    band,
  }
}

/** The day under a point across the chart (a pointer), or null outside the plot. */
export function dayAt(layout: ChartLayout, x: number, rtl: boolean): number | null {
  if (layout.days.length === 0 || x < layout.left || x > layout.right) return null
  const offset = rtl ? layout.right - x : x - layout.left
  return Math.min(layout.days.length - 1, Math.max(0, Math.floor(offset / layout.band)))
}

/**
 * The days whose number is written under the axis: the 1st, then every 7th (8, 15, 22, 29), and the
 * last one when it is not too close to the one before.
 */
export function labelledDays(count: number): number[] {
  const marks: number[] = []
  for (let index = 0; index < count; index += 7) marks.push(index)
  const last = count - 1
  if (count > 0 && !marks.includes(last) && last - (marks.at(-1) ?? 0) >= 3) marks.push(last)
  return marks
}
