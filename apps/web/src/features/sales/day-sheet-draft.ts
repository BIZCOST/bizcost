import type { CreateSaleInput, DaySheetDto, SaleDto } from '@bizcost/contracts'
import {
  compareDecimal,
  computeSale,
  newId,
  parseNumber,
  SALE_LINE_QTY_MAX,
  saleError,
  subtractDecimals,
  sumDecimals,
  type CurrencyCode,
  type Money,
  type Quantity,
  type SaleAmounts,
  type SaleLineAmounts,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { readAmount, readQuantity, type FieldError } from '../catalog/numbers'

// Today's sales («مبيعات اليوم», M3 Step 2; Q9, Q10): the member's sheet for a day (or several days of
// one month), a channel and a branch. One row per product of the branch, with how many were sold
// (− / + or typed, Arabic-Indic digits too) and the price filled in (the member's last price there,
// else the usual one; changed for the day on the row). The running amounts are the domain's sale
// maths (computeSale, D-220), the same the API stores. What is saved: one item line per product sold
// (a row left at 0 or empty is not a sale); a stored line keeps its id.

type SheetProduct = DaySheetDto['data']['products'][number]

/** A product on the sheet: what the amounts and the row need of it. */
export interface SheetItem {
  readonly productId: string
  readonly name: string
  readonly unit: StandardUnit | null
  readonly priceIncludesVat: boolean
  /** Null for a business not registered for VAT. */
  readonly vatCategory: VatCategory | null
  /** No longer listed for this branch (archived, or not sold here now): kept while its line is. */
  readonly gone: boolean
}

/** A row as typed: its line's id (kept when stored), how many and the price. */
export interface SheetRow {
  readonly lineId: string
  readonly qty: string
  readonly price: string
}

/** The sheet's rows, by product id. */
export type SheetDraft = Readonly<Record<string, SheetRow>>

/** The products of the sheet: the branch's, then those its stored lines name that are not listed. */
export function sheetItems(products: readonly SheetProduct[], sheet: SaleDto | null): SheetItem[] {
  const items: SheetItem[] = products.map((product) => ({
    productId: product.productId,
    name: product.name,
    unit: product.unit,
    priceIncludesVat: product.priceIncludesVat,
    vatCategory: product.vatCategory,
    gone: false,
  }))
  const listed = new Set(items.map((item) => item.productId))
  for (const line of sheet?.lines ?? []) {
    if (line.kind !== 'item' || line.productId === null || listed.has(line.productId)) continue
    listed.add(line.productId)
    items.push({
      productId: line.productId,
      name: line.description ?? '',
      unit: line.unit,
      priceIncludesVat: line.priceIncludesVat,
      vatCategory: line.vatCategory,
      gone: true,
    })
  }
  return items
}

/**
 * The rows' first state: a stored line's quantity and price (and id), else nothing sold at the
 * filled-in price.
 */
export function sheetDraft(
  items: readonly SheetItem[],
  products: readonly SheetProduct[],
  sheet: SaleDto | null,
): SheetDraft {
  const prices = new Map(products.map((product) => [product.productId, product.price]))
  const stored = new Map<string, SaleDto['lines'][number]>()
  for (const line of sheet?.lines ?? []) {
    if (line.kind === 'item' && line.productId && !stored.has(line.productId)) {
      stored.set(line.productId, line)
    }
  }
  return Object.fromEntries(
    items.map((item) => {
      const line = stored.get(item.productId)
      const row: SheetRow = line
        ? { lineId: line.id, qty: line.qty, price: line.unitPrice }
        : { lineId: newId(), qty: '', price: prices.get(item.productId) ?? '' }
      return [item.productId, row] as const
    }),
  )
}

/** A row's quantity one more or one less (never below zero; zero shows as empty). */
export function stepQty(qty: string, step: 1 | -1): string {
  const read = parseNumber(qty)
  const current = read.ok && compareDecimal(read.value, '0') > 0 ? read.value : '0'
  const next = step === 1 ? sumDecimals([current, '1']) : subtractDecimals(current, '1')
  return compareDecimal(next, '0') > 0 ? next : ''
}

export interface RowErrors {
  qty?: FieldError
  price?: FieldError
}

export interface CheckedSheet {
  /** By product id. */
  readonly errors: Readonly<Record<string, RowErrors>>
  /** The item lines to save: one per product sold. */
  readonly lines: Extract<CreateSaleInput['lines'], readonly unknown[]>
  /** The running amounts of the rows that read (null when none does). */
  readonly amounts: SaleAmounts | null
  /** Each counted row's amounts, by product id. */
  readonly lineAmounts: ReadonlyMap<string, SaleLineAmounts>
  /** Whether every row reads (the sheet can be saved). */
  readonly valid: boolean
}

/** Whether a quantity as typed means "nothing sold" (empty or zero). */
function isNothing(qty: string): boolean {
  if (qty.trim() === '') return true
  const read = parseNumber(qty)
  return read.ok && compareDecimal(read.value, '0') === 0
}

/** Every row's problem, the lines to save and the running amounts. */
export function checkSheet(
  items: readonly SheetItem[],
  draft: SheetDraft,
  context: { readonly currency: CurrencyCode; readonly vatRegistered: boolean },
): CheckedSheet {
  const errors: Record<string, RowErrors> = {}
  const lines: CheckedSheet['lines'] = []
  const counted: { productId: string; item: SheetItem; qty: string; price: string }[] = []
  for (const item of items) {
    const row = draft[item.productId]
    if (!row || isNothing(row.qty)) continue
    const rowErrors: RowErrors = {}
    const qty = readQuantity(row.qty)
    if (!qty.ok) rowErrors.qty = qty.error
    else if (compareDecimal(qty.value, SALE_LINE_QTY_MAX) > 0) {
      rowErrors.qty = { key: 'catalog.numbers.tooLarge' }
    }
    const price = readAmount(row.price)
    if (!price.ok) rowErrors.price = price.error
    if (rowErrors.qty || rowErrors.price) {
      errors[item.productId] = rowErrors
      continue
    }
    const value = {
      qty: (qty as { value: string }).value,
      price: (price as { value: string }).value,
    }
    counted.push({ productId: item.productId, item, ...value })
    lines.push({
      kind: 'item',
      id: row.lineId,
      productId: item.productId,
      qty: value.qty,
      unitPrice: value.price,
    })
  }
  const input = {
    vatRegistered: context.vatRegistered,
    lines: counted.map(({ item, qty, price }) => ({
      kind: 'item' as const,
      qty: qty as Quantity,
      unitPrice: price as Money,
      priceIncludesVat: item.priceIncludesVat,
      vatCategory: item.vatCategory ?? ('standard' as const),
    })),
  }
  const amounts =
    counted.length > 0 && saleError(input, context.currency) === null
      ? computeSale(input, context.currency)
      : null
  const lineAmounts = new Map(
    amounts ? counted.map((row, index) => [row.productId, amounts.lines[index]!] as const) : [],
  )
  return { errors, lines, amounts, lineAmounts, valid: Object.keys(errors).length === 0 }
}
