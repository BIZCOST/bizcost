import type { CountListInput } from '@bizcost/contracts'
import {
  DOCUMENT_STATUSES,
  isUuid,
  STOCK_COUNT_KINDS,
  type DocumentStatus,
  type StockCountKind,
} from '@bizcost/domain'

// The filters of the counts list and of the stock page (M4 Step 2), kept in the address so a reload
// or a shared link shows the same list: counts by `?status=` (draft, posted: "Finalized" on screen,
// reversed), `?kind=` (first counts or counts) and `?branch=`; stock by `?branch=` and `?q=` (a part
// of the name). Values the address holds but the API would refuse are left out.

export const COUNT_STATUS_FILTERS = ['all', ...DOCUMENT_STATUSES] as const
export type CountStatusFilter = 'all' | DocumentStatus

export interface CountFilters {
  readonly status: CountStatusFilter
  readonly kind: StockCountKind | null
  readonly locationId: string | null
}

export interface StockFilters {
  readonly locationId: string | null
  readonly search: string
}

function isStatus(value: string | null): value is CountStatusFilter {
  return (COUNT_STATUS_FILTERS as readonly (string | null)[]).includes(value)
}

function isKind(value: string | null): value is StockCountKind {
  return (STOCK_COUNT_KINDS as readonly (string | null)[]).includes(value)
}

function id(value: string | null): string | null {
  return value && isUuid(value) ? value.toLowerCase() : null
}

export function readCountFilters(params: URLSearchParams): CountFilters {
  const status = params.get('status')
  const kind = params.get('kind')
  return {
    status: isStatus(status) ? status : 'all',
    kind: isKind(kind) ? kind : null,
    locationId: id(params.get('branch')),
  }
}

export function readStockFilters(params: URLSearchParams): StockFilters {
  return { locationId: id(params.get('branch')), search: (params.get('q') ?? '').trim() }
}

/** The address's query with `next` applied (defaults are left out). */
export function writeFilters(
  params: URLSearchParams,
  next: Partial<CountFilters & StockFilters>,
): string {
  const query = new URLSearchParams(params.toString())
  const put = (name: string, value: string | null | undefined, empty: string | null = null) => {
    if (value === undefined) return
    if (value === null || value === '' || value === empty) query.delete(name)
    else query.set(name, value)
  }
  put('status', next.status, 'all')
  put('kind', next.kind)
  put('branch', next.locationId)
  put('q', next.search?.trim())
  return query.toString()
}

/** Whether any filter narrows the counts list. */
export function countsFiltered(filters: CountFilters): boolean {
  return filters.status !== 'all' || filters.kind !== null || filters.locationId !== null
}

/** count.list's input for the filters (without the cursor). */
export function countListInput(filters: CountFilters): CountListInput {
  return {
    status: filters.status,
    kind: filters.kind ?? undefined,
    locationId: filters.locationId ?? undefined,
  }
}
