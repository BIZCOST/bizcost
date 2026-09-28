import type { PurchaseDto, PurchaseReturnDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import {
  checkReturn,
  creditTotal,
  quantityLeft,
  returnableLines,
  returnAmount,
  returnDraft,
} from './return-draft'

// Supplier returns and credit notes of a final purchase: at most what is left of a line, never
// before the purchase, and one line per purchase line (its id kept when a draft is saved again).

const TODAY = '2026-09-28'

const PURCHASE = {
  id: 'p1',
  businessDate: '2026-09-20',
  currency: 'AED',
  lines: [
    { id: 'l1', kind: 'material', qty: '3', returnedQty: '1', packName: 'bag', unit: null },
    { id: 'l2', kind: 'material', qty: '10', returnedQty: '0', packName: null, unit: 'kg' },
    { id: 'd1', kind: 'delivery', qty: '1', returnedQty: '0', packName: null, unit: null },
  ],
} as unknown as PurchaseDto

describe('supplier returns and credit notes', () => {
  it('offers the material lines, with what is left of each', () => {
    expect(returnableLines(PURCHASE).map((line) => line.id)).toEqual(['l1', 'l2'])
    expect(quantityLeft(PURCHASE.lines[0]!)).toBe('2')
  })

  it('a return: at most what is left, in Arabic digits too', () => {
    const draft = { ...returnDraft('return', undefined, TODAY), values: { l1: '٢', l2: '' } }
    const checked = checkReturn('return', draft, PURCHASE, { today: TODAY })
    expect(checked.fields).toMatchObject({
      businessDate: TODAY,
      reference: null,
      splitAmount: null,
      lines: [{ purchaseLineId: 'l1', qty: '2' }],
    })
    const over = checkReturn('return', { ...draft, values: { l1: '3' } }, PURCHASE, {
      today: TODAY,
    })
    expect(over.errors.lines.l1?.key).toBe('errors.exceeds_purchase')
    expect(over.fields).toBeNull()
  })

  it('needs something to return or credit, on a day from the purchase to today', () => {
    const empty = returnDraft('return', undefined, TODAY)
    expect(checkReturn('return', empty, PURCHASE, { today: TODAY }).errors.document?.key).toBe(
      'purchasing.returns.pickReturn',
    )
    const early = { ...empty, businessDate: '2026-09-19', values: { l2: '1' } }
    expect(checkReturn('return', early, PURCHASE, { today: TODAY }).errors.businessDate?.key).toBe(
      'purchasing.returns.beforePurchase',
    )
    const late = { ...empty, businessDate: '2026-09-29', values: { l2: '1' } }
    expect(checkReturn('return', late, PURCHASE, { today: TODAY }).errors.businessDate?.key).toBe(
      'errors.future_date',
    )
  })

  it('a credit note: an amount per line, or one amount the API shares', () => {
    const perLine = { ...returnDraft('credit_note', undefined, TODAY), values: { l2: '10' } }
    expect(checkReturn('credit_note', perLine, PURCHASE, { today: TODAY }).fields).toMatchObject({
      lines: [{ purchaseLineId: 'l2', amount: '10' }],
      splitAmount: null,
    })
    const split = { ...perLine, split: true, splitAmount: '١٥' }
    expect(checkReturn('credit_note', split, PURCHASE, { today: TODAY }).fields).toMatchObject({
      lines: [],
      splitAmount: '15',
    })
    const zero = { ...perLine, values: { l2: '0' } }
    expect(checkReturn('credit_note', zero, PURCHASE, { today: TODAY }).errors.lines.l2?.key).toBe(
      'catalog.numbers.positive',
    )
    // A document amount: never finer than the currency (AED has 2 decimals, D-142).
    const fils = { ...perLine, values: { l2: '10.005' } }
    expect(checkReturn('credit_note', fils, PURCHASE, { today: TODAY }).errors.lines.l2?.key).toBe(
      'catalog.numbers.tooManyDecimals',
    )
    const splitFils = { ...split, splitAmount: '1.505' }
    expect(
      checkReturn('credit_note', splitFils, PURCHASE, { today: TODAY }).errors.splitAmount?.key,
    ).toBe('catalog.numbers.tooManyDecimals')
  })

  it('keeps the line ids of a saved draft', () => {
    const stored = {
      businessDate: '2026-09-25',
      reference: 'RN-1',
      notes: null,
      lines: [{ id: 'r1', purchaseLineId: 'l2', qty: '4', amount: null }],
    } as unknown as PurchaseReturnDto
    const draft = returnDraft('return', stored, TODAY)
    expect(draft).toMatchObject({
      businessDate: '2026-09-25',
      reference: 'RN-1',
      values: { l2: '4' },
    })
    expect(checkReturn('return', draft, PURCHASE, { today: TODAY, stored }).fields?.lines).toEqual([
      { id: 'r1', purchaseLineId: 'l2', qty: '4' },
    ])
  })

  it('says what a return and a credit note are worth before they are final', () => {
    const priced = {
      ...PURCHASE,
      lines: [
        { ...PURCHASE.lines[0]!, taxable: '135', returnedAmount: '45', creditedAmount: '0' },
        { ...PURCHASE.lines[1]!, taxable: '100', returnedAmount: '0', creditedAmount: '10' },
      ],
    } as PurchaseDto
    // l1: 2 bags left, carrying 90; l2: 10 kg left, carrying 90 after a credit of 10.
    const fields = {
      businessDate: TODAY,
      reference: null,
      notes: null,
      splitAmount: null,
      lines: [
        { id: 'a', purchaseLineId: 'l1', qty: '2' },
        { id: 'b', purchaseLineId: 'l2', qty: '3' },
      ],
    }
    expect(returnAmount(priced, fields)).toBe('117')
    // Hidden amounts: nothing to say.
    expect(returnAmount(PURCHASE, fields)).toBeNull()
    expect(
      creditTotal({ ...fields, lines: [{ id: 'c', purchaseLineId: 'l2', amount: '12.5' }] }),
    ).toBe('12.5')
    expect(creditTotal({ ...fields, lines: [], splitAmount: '40' })).toBe('40')
  })
})
