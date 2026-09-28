import type { PurchaseListInput } from '@bizcost/contracts'
import { DOCUMENT_STATUSES, isUuid, type DocumentStatus } from '@bizcost/domain'

// The purchases list's filters (M2 Step 3), kept in the address so a reload or a shared link shows
// the same list: `?status=`, `?supplier=`, `?from=`, `?to=` (business days) and `?q=` (the reference
// or the supplier's name). Values the address holds but the API would refuse are left out.

export const PURCHASE_STATUS_FILTERS = ['all', ...DOCUMENT_STATUSES] as const
export type PurchaseStatusFilter = 'all' | DocumentStatus

export interface PurchaseFilters {
  readonly status: PurchaseStatusFilter
  readonly supplierId: string | null
  readonly from: string | null
  readonly to: string | null
  readonly search: string
}

const BUSINESS_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function isStatus(value: string | null): value is PurchaseStatusFilter {
  return (PURCHASE_STATUS_FILTERS as readonly (string | null)[]).includes(value)
}

function day(value: string | null): string | null {
  return value && BUSINESS_DAY.test(value) ? value : null
}

export function readPurchaseFilters(params: URLSearchParams): PurchaseFilters {
  const status = params.get('status')
  const supplier = params.get('supplier')
  return {
    status: isStatus(status) ? status : 'all',
    supplierId: supplier && isUuid(supplier) ? supplier.toLowerCase() : null,
    from: day(params.get('from')),
    to: day(params.get('to')),
    search: (params.get('q') ?? '').trim(),
  }
}

/** The address's query with `next` applied (defaults are left out). */
export function writePurchaseFilters(
  params: URLSearchParams,
  next: Partial<PurchaseFilters>,
): string {
  const query = new URLSearchParams(params.toString())
  const put = (name: string, value: string | null | undefined, empty: string | null = null) => {
    if (value === undefined) return
    if (value === null || value === '' || value === empty) query.delete(name)
    else query.set(name, value)
  }
  put('status', next.status, 'all')
  put('supplier', next.supplierId)
  put('from', next.from)
  put('to', next.to)
  put('q', next.search?.trim())
  return query.toString()
}

/** Whether any filter narrows the list (the first-time page shows only without one). */
export function isFiltered(filters: PurchaseFilters): boolean {
  return (
    filters.status !== 'all' ||
    filters.supplierId !== null ||
    filters.from !== null ||
    filters.to !== null ||
    filters.search !== ''
  )
}

/** purchase.list's input for the filters (without the cursor). */
export function listInput(filters: PurchaseFilters): PurchaseListInput {
  return {
    status: filters.status,
    supplierId: filters.supplierId ?? undefined,
    from: filters.from ?? undefined,
    to: filters.to ?? undefined,
    search: filters.search || undefined,
  }
}
