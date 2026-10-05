'use client'

import { formatDate, formatNumber } from '@bizcost/i18n'
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { NBSP } from '@/features/catalog/units'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { useLocale } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { chartLayout, dayAt, labelledDays } from './chart-geometry'

// "Sales and real profit by day" (M3 Step 3, Q14): the one chart BizCost draws itself (no chart
// library), every day of the month so far. The sales are columns (chart-1) and the real profit a 2px
// line with its points (chart-2) on one axis in the business currency; a day without sales sits on 0
// and a day at a loss goes under it. Mirrored in Arabic: the first day at the right, the axis'
// labels at the right. A legend names both series; pointing at a day (or tapping it on a phone) shows
// its figures. Screen readers get a summary and a table of every day instead of the drawing. Without
// profit seen (the API withholds it), only the sales.

export interface ChartDay {
  readonly day: string
  readonly sales: string
  readonly profit: string | null
}

const HEIGHT = 220
const TOP = 12
const BOTTOM = 28
/** Room for the axis' labels: a digit is about 7px at 11px. */
const DIGIT = 7

/** The chart's width as drawn (it follows its box; 600 until measured). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

export function SalesProfitChart({ days }: { days: readonly ChartDay[] }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const id = useId()
  const { ref, width } = useWidth()
  const [active, setActive] = useState<number | null>(null)
  const rtl = locale === 'ar'
  const withProfit = days.some((day) => day.profit !== null)
  // Numbers only to place the marks; every figure shown is the decimal string, formatted.
  const points = days.map((day) => ({
    sales: Number(day.sales),
    profit: day.profit === null ? null : Number(day.profit),
  }))
  const tick = (value: number) => formatNumber(locale, value, { maximumFractionDigits: 2 })
  const probe = chartLayout(points, {
    width,
    height: HEIGHT,
    start: 0,
    end: 0,
    top: TOP,
    bottom: BOTTOM,
    rtl,
  })
  const labelRoom =
    Math.max(...probe.scale.ticks.map((value) => tick(value).length), 1) * DIGIT + 12
  const layout = chartLayout(points, {
    width,
    height: HEIGHT,
    start: labelRoom,
    end: 8,
    top: TOP,
    bottom: BOTTOM,
    rtl,
  })
  const dayNumber = (day: string) =>
    formatDate(locale, `${day}T00:00:00Z`, { day: 'numeric', timeZone: 'UTC' })
  const linePath = withProfit
    ? layout.days
        .map((mark, index) => `${index === 0 ? 'M' : 'L'}${pixel(mark.x)},${pixel(mark.profitY!)}`)
        .join(' ')
    : ''
  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setActive(dayAt(layout, ((event.clientX - box.left) / box.width) * width, rtl))
  }
  const first = days[0]?.day
  const last = days.at(-1)?.day
  const summary =
    first && last
      ? t(withProfit ? 'dashboard.cards.chart.summary' : 'dashboard.cards.chart.summarySales', {
          from: businessDate(first),
          to: businessDate(last),
        })
      : ''
  const activeDay = active === null ? null : (days[active] ?? null)
  const activeMark = active === null ? null : (layout.days[active] ?? null)
  const tooltipWidth = 184
  // The figures' box beside the day, kept inside the chart (in the page's own direction).
  const tooltipStart =
    activeMark === null
      ? 0
      : Math.min(
          Math.max(0, (rtl ? width - activeMark.x : activeMark.x) - tooltipWidth / 2),
          Math.max(0, width - tooltipWidth),
        )

  return (
    <figure aria-labelledby={`${id}-caption`} className="space-y-3">
      <figcaption id={`${id}-caption`} className="sr-only">
        {summary}
      </figcaption>
      {/* The legend: both series named, never by color alone. */}
      <ul aria-hidden className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-chart-1" />
          {t('dashboard.cards.chart.sales')}
        </li>
        {withProfit ? (
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-full bg-chart-2" />
            {t('dashboard.cards.chart.profit')}
          </li>
        ) : null}
      </ul>
      <div ref={ref} className="relative">
        <svg
          aria-hidden
          data-chart="sales-profit"
          data-direction={rtl ? 'rtl' : 'ltr'}
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block touch-pan-y overflow-visible select-none"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setActive(null)}
        >
          {/* The axis: hairlines at round amounts, 0 a little stronger. */}
          {layout.ticks.map(({ value, y }) => (
            <g key={value}>
              <line
                x1={layout.left}
                x2={layout.right}
                y1={y}
                y2={y}
                className={cn(value === 0 ? 'stroke-foreground/25' : 'stroke-foreground/[0.07]')}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={layout.labelX}
                y={y}
                dy="0.32em"
                direction="ltr"
                textAnchor={rtl ? 'start' : 'end'}
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {tick(value)}
              </text>
            </g>
          ))}
          {activeMark ? (
            <rect
              x={activeMark.x - layout.band / 2}
              y={TOP}
              width={layout.band}
              height={HEIGHT - TOP - BOTTOM}
              className="fill-foreground/[0.04]"
            />
          ) : null}
          {/* Sales: a column per day, rounded at its value's end only. */}
          {layout.days.map((mark) =>
            mark.barHeight > 0 ? (
              <path
                key={mark.index}
                data-day-bar={days[mark.index]!.day}
                d={columnPath(mark, layout.zeroY)}
                className={cn(
                  'fill-chart-1',
                  active !== null && active !== mark.index && 'opacity-60',
                )}
              />
            ) : null,
          )}
          {/* Real profit: a 2px line, with a point on each day (ringed in the card's color). */}
          {withProfit ? (
            <>
              <path
                d={linePath}
                fill="none"
                className="stroke-chart-2"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {layout.days.map((mark) => (
                <circle
                  key={mark.index}
                  cx={mark.x}
                  cy={mark.profitY!}
                  r={active === mark.index ? 5 : days.length > 20 ? 2.5 : 4}
                  className="fill-chart-2 stroke-card"
                  strokeWidth={2}
                />
              ))}
            </>
          ) : null}
          {/* The days' numbers under the axis: the 1st, then every 7th. */}
          {labelledDays(days.length).map((index) => (
            <text
              key={index}
              x={layout.days[index]!.x}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {dayNumber(days[index]!.day)}
            </text>
          ))}
        </svg>
        {activeDay && activeMark ? (
          <div
            data-chart-tooltip
            className="pointer-events-none absolute top-0 z-10 rounded-xl bg-popover px-3 py-2 text-xs shadow-md ring-1 ring-foreground/10"
            style={{ insetInlineStart: tooltipStart, width: tooltipWidth }}
          >
            <p className="font-medium">{businessDate(activeDay.day)}</p>
            <p className="mt-1 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span aria-hidden className="size-2 rounded-[2px] bg-chart-1" />
                {t('dashboard.cards.chart.sales')}
              </span>
              <bdi className="tabular-nums">{money(activeDay.sales).replaceAll(' ', NBSP)}</bdi>
            </p>
            {activeDay.profit !== null ? (
              <p className="mt-0.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden className="h-0.5 w-2.5 rounded-full bg-chart-2" />
                  {t('dashboard.cards.chart.profit')}
                </span>
                <bdi
                  className={cn('tabular-nums', activeDay.profit.startsWith('-') && 'text-loss')}
                >
                  {money(activeDay.profit).replaceAll(' ', NBSP)}
                </bdi>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* What screen readers get instead of the drawing: every day's figures. */}
      <table className="sr-only">
        <caption>{t('dashboard.cards.chart.table')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.cards.chart.day')}</th>
            <th scope="col">{t('dashboard.cards.chart.sales')}</th>
            {withProfit ? <th scope="col">{t('dashboard.cards.chart.profit')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{businessDate(day.day)}</th>
              <td>{money(day.sales)}</td>
              {withProfit ? <td>{day.profit === null ? '—' : money(day.profit)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

/** A position on the screen to a tenth of a pixel (geometry only, never an amount). */
function pixel(n: number): string {
  return String(Math.round(n * 10) / 10)
}

/** A column from the 0 line, its value's end rounded (4px), its base square. */
function columnPath(
  mark: { barX: number; barY: number; barWidth: number; barHeight: number },
  zeroY: number,
): string {
  const { barX: x, barWidth: w, barHeight: h } = mark
  const r = Math.min(4, w / 2, h)
  const up = mark.barY < zeroY - 0.01
  const f = pixel
  if (up) {
    const top = mark.barY
    const base = top + h
    return `M${f(x)},${f(base)} V${f(top + r)} Q${f(x)},${f(top)} ${f(x + r)},${f(top)} H${f(x + w - r)} Q${f(x + w)},${f(top)} ${f(x + w)},${f(top + r)} V${f(base)} Z`
  }
  // Below 0 (a day of refunds): rounded at the bottom.
  const top = zeroY
  const bottom = top + h
  return `M${f(x)},${f(top)} V${f(bottom - r)} Q${f(x)},${f(bottom)} ${f(x + r)},${f(bottom)} H${f(x + w - r)} Q${f(x + w)},${f(bottom)} ${f(x + w)},${f(bottom - r)} V${f(top)} Z`
}
