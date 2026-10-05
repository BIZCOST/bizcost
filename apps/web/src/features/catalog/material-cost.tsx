'use client'

import { useTRPC } from '@bizcost/app-core'
import type { MaterialCostDto, MaterialDto } from '@bizcost/contracts'
import { BASE_UNITS, compareDecimal, type StandardUnit } from '@bizcost/domain'
import { useQueries } from '@tanstack/react-query'
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Locked, useBusinessDate, useUnitCost } from '@/features/documents/amounts'
import { NBSP } from './units'

// A material's cost on the Materials page (M2 Step 3; D-115, D-138): its average cost, saying which
// average it is (until the business's first stock count, the average of its purchases of the last 90
// days, or its last purchase when there is none in them), and its last purchase cost (what one unit
// really cost: after discounts, with delivery, net of returns and credits; D-143) per the unit it is
// counted in, per the pack it was bought in and per base unit, with the day. The main value leads,
// the rest follows on a muted line; a conversion that repeats the same amount is left out. A
// material never bought has "no price yet", never 0. The average is `cost` and the prices
// `supplier_price`: a member who may not see them sees a lock (redaction).

/** The costs of the materials of each loaded page of the list (material.costs takes a page). */
export function useMaterialCosts(
  pages: readonly { readonly items: readonly MaterialDto[] }[],
  enabled: boolean,
): ReadonlyMap<string, MaterialCostDto> {
  const trpc = useTRPC()
  const results = useQueries({
    queries: pages.map((page) => ({
      ...trpc.material.costs.queryOptions({ ids: page.items.map((material) => material.id) }),
      enabled: enabled && page.items.length > 0,
    })),
  })
  return new Map(
    results
      .flatMap((result) => result.data?.data.items ?? [])
      .map((cost) => [cost.materialId, cost] as const),
  )
}

/** "AED 6.67 per L", "AED 84.00 per carton". */
function usePer() {
  const unitCost = useUnitCost()
  // Never broken inside: "AED 0.040 per g" stays on one line.
  return (amount: string, per: string) => `${unitCost(amount)}${NBSP}${per.replaceAll(' ', NBSP)}`
}

/**
 * One cost: its label and main value (per the unit the material is counted in) on a line, and what
 * else it says on a muted line under it (amounts and the day never break inside: no-break spaces).
 */
function Line({
  label,
  value,
  details,
}: {
  label: string
  value: ReactNode
  details: readonly ReactNode[]
}) {
  return (
    <span data-cost={label} className="mt-1 block">
      <span className="block">
        <span className="text-foreground">{label}:</span> {value}
      </span>
      {details.length > 0 ? (
        <span className="block text-xs">
          {details.map((detail, index) => (
            <Fragment key={index}>
              {index > 0 ? ' · ' : null}
              {detail}
            </Fragment>
          ))}
        </span>
      ) : null}
    </span>
  )
}

/** The average cost and the last purchase cost, in the list's details. */
export function MaterialCostDetails({
  material,
  cost,
}: {
  material: MaterialDto
  cost: MaterialCostDto | undefined
}) {
  const { t } = useTranslation()
  const per = usePer()
  const businessDate = useBusinessDate()
  if (!cost) return null
  const unit = material.unit
  const base = BASE_UNITS[material.dimension]
  const perUnit = (u: StandardUnit) => t(`units.per.${u}`)
  const average = cost.average
  const last = cost.lastPurchase

  let averageLine: ReactNode
  if (!average) {
    averageLine = (
      <Line
        label={t('catalog.materials.cost.average')}
        value={t('catalog.materials.cost.noPrice')}
        details={[]}
      />
    )
  } else if (average.perUnit === undefined || average.perBaseUnit === undefined) {
    averageLine = (
      <Line
        label={t('catalog.materials.cost.average')}
        value={<Locked category="cost" />}
        details={[t(`catalog.materials.cost.basis.${average.basis}`)]}
      />
    )
  } else {
    averageLine = (
      <Line
        label={t('catalog.materials.cost.average')}
        value={
          <bdi className="font-medium whitespace-nowrap text-foreground tabular-nums">
            {per(average.perUnit, perUnit(unit))}
          </bdi>
        }
        details={[
          ...(base !== unit
            ? [
                <bdi key="base" className="tabular-nums">
                  {per(average.perBaseUnit, perUnit(base))}
                </bdi>,
              ]
            : []),
          t(`catalog.materials.cost.basis.${average.basis}`),
        ]}
      />
    )
  }

  let lastLine: ReactNode = null
  if (last) {
    const purchaseUnit = last.packName ?? (last.unit ? t(`units.short.${last.unit}`) : '')
    const day = businessDate(last.businessDate).replaceAll(' ', NBSP)
    const hint = t('catalog.materials.cost.lastPurchaseHint')
    if (
      last.pricePerPurchaseUnit === undefined ||
      last.pricePerUnit === undefined ||
      last.pricePerBaseUnit === undefined
    ) {
      lastLine = (
        <Line
          label={t('catalog.materials.cost.lastPurchase')}
          value={<Locked category="supplier_price" />}
          details={[day]}
        />
      )
    } else {
      // Bought in a pack or another unit: its cost per that pack too, unless it is the same amount
      // (a bag of 1 kg); per base unit unless the material is counted in it.
      const inPack =
        (last.packId !== null || (last.unit !== null && last.unit !== unit)) &&
        compareDecimal(last.pricePerPurchaseUnit, last.pricePerUnit) !== 0
      lastLine = (
        <Line
          label={t('catalog.materials.cost.lastPurchase')}
          value={
            <bdi className="font-medium whitespace-nowrap text-foreground tabular-nums">
              {per(last.pricePerUnit, perUnit(unit))}
            </bdi>
          }
          details={[
            ...(inPack
              ? [
                  <bdi key="pack" className="tabular-nums">
                    {per(
                      last.pricePerPurchaseUnit,
                      t('catalog.materials.cost.perPack', { unit: purchaseUnit }),
                    )}
                  </bdi>,
                ]
              : []),
            ...(base !== unit
              ? [
                  <bdi key="base" className="tabular-nums">
                    {per(last.pricePerBaseUnit, perUnit(base))}
                  </bdi>,
                ]
              : []),
            hint,
            day,
          ]}
        />
      )
    }
  }

  return (
    <>
      {averageLine}
      {lastLine}
    </>
  )
}
