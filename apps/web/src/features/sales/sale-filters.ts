import type { SaleListInput } from '@bizcost/contracts'
import {
  DOCUMENT_STATUSES,
  isUuid,
  SALE_SOURCES,
  type DocumentStatus,
  type SaleSource,
} from '@bizcost/domain'

// The Sales list's filters (M3 Step 2), kept in the address so a reload or a shared link shows the
// same list: `?status=`, `?kind=` (Today's sales or One sale), `?channel=`, `?branch=`, `?from=`,
// `?to=` (business days) and `?q=` (what was sold, never an amount: D-209). Values the address holds
// but the API would refuse are left out.

export const SALE_STATUS_FILTERS = ['all', ...DOCUMENT_STATUSES] as const
export type SaleStatusFilter = 'all' | DocumentStatus

export interface SaleFilters {
  readonly status: SaleStatusFilter
  readonly source: SaleSource | null
  readonly channelId: string | null
  readonly locationId: string | null
  readonly from: string | null
  readonly to: string | null
  readonly search: string
}

const BUSINESS_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function isStatus(value: string | null): value is SaleStatusFilter {
  return (SALE_STATUS_FILTERS as readonly (string | null)[]).includes(value)
}

function isSource(value: string | null): value is SaleSource {
  return (SALE_SOURCES as readonly (string | null)[]).includes(value)
}

function day(value: string | null): string | null {
  return value && BUSINESS_DAY.test(value) ? value : null
}

function id(value: string | null): string | null {
  return value && isUuid(value) ? value.toLowerCase() : null
}

export function readSaleFilters(params: URLSearchParams): SaleFilters {
  const status = params.get('status')
  const kind = params.get('kind')
  return {
    status: isStatus(status) ? status : 'all',
    source: isSource(kind) ? kind : null,
    channelId: id(params.get('channel')),
    locationId: id(params.get('branch')),
    from: day(params.get('from')),
    to: day(params.get('to')),
    search: (params.get('q') ?? '').trim(),
  }
}

/** The address's query with `next` applied (defaults are left out). */
export function writeSaleFilters(params: URLSearchParams, next: Partial<SaleFilters>): string {
  const query = new URLSearchParams(params.toString())
  const put = (name: string, value: string | null | undefined, empty: string | null = null) => {
    if (value === undefined) return
    if (value === null || value === '' || value === empty) query.delete(name)
    else query.set(name, value)
  }
  put('status', next.status, 'all')
  put('kind', next.source)
  put('channel', next.channelId)
  put('branch', next.locationId)
  put('from', next.from)
  put('to', next.to)
  put('q', next.search?.trim())
  return query.toString()
}

/** Whether any filter narrows the list (the first-time page shows only without one). */
export function isFiltered(filters: SaleFilters): boolean {
  return (
    filters.status !== 'all' ||
    filters.source !== null ||
    filters.channelId !== null ||
    filters.locationId !== null ||
    filters.from !== null ||
    filters.to !== null ||
    filters.search !== ''
  )
}

/** sale.list's input for the filters (without the cursor). */
export function listInput(filters: SaleFilters): SaleListInput {
  return {
    status: filters.status,
    source: filters.source ?? undefined,
    channelId: filters.channelId ?? undefined,
    locationId: filters.locationId ?? undefined,
    from: filters.from ?? undefined,
    to: filters.to ?? undefined,
    search: filters.search || undefined,
  }
}

/** The filters with none set. */
export const NO_FILTERS: SaleFilters = {
  status: 'all',
  source: null,
  channelId: null,
  locationId: null,
  from: null,
  to: null,
  search: '',
}
