import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_ACCENTS,
  isDocumentAccent,
  QUOTATION_STATUSES,
  quotationActions,
  quotationListStatus,
  quotationTransition,
  type QuotationActionContext,
  type QuotationStatus,
} from './quotation'

// A quotation's revisions (Q21–Q25): what each action does in each status, and the accents of the
// letterhead.

const ctx = (
  status: QuotationStatus,
  more: Partial<QuotationActionContext> = {},
): QuotationActionContext => ({
  status,
  latest: true,
  hasOrder: false,
  otherHasOrder: false,
  ...more,
})

describe('quotationTransition', () => {
  it('a draft is edited, discarded or sent; nothing is decided on it', () => {
    expect(quotationActions(ctx('draft'))).toEqual(['update', 'discard', 'send', 'copy'])
    expect(quotationTransition('accept', ctx('draft'))).toEqual({
      ok: false,
      refusal: 'quotation_not_sent',
    })
    expect(quotationTransition('revise', ctx('draft'))).toEqual({
      ok: false,
      refusal: 'quotation_not_sent',
    })
  })

  it('a sent revision is frozen: accepted, declined or revised; a repeated send changes nothing', () => {
    expect(quotationActions(ctx('sent'))).toEqual(['revise', 'accept', 'decline', 'copy'])
    expect(quotationTransition('update', ctx('sent'))).toEqual({
      ok: false,
      refusal: 'quotation_frozen',
    })
    expect(quotationTransition('discard', ctx('sent'))).toEqual({
      ok: false,
      refusal: 'quotation_frozen',
    })
    expect(quotationTransition('send', ctx('sent'))).toEqual({
      ok: true,
      to: 'sent',
      changes: false,
    })
  })

  it('accepting or declining again changes nothing; the other answer is refused', () => {
    expect(quotationTransition('accept', ctx('accepted'))).toMatchObject({ changes: false })
    expect(quotationTransition('decline', ctx('declined'))).toMatchObject({ changes: false })
    expect(quotationTransition('accept', ctx('declined'))).toEqual({
      ok: false,
      refusal: 'quotation_decided',
    })
    expect(quotationTransition('decline', ctx('accepted'))).toEqual({
      ok: false,
      refusal: 'quotation_decided',
    })
    expect(quotationTransition('decline', ctx('accepted', { hasOrder: true }))).toEqual({
      ok: false,
      refusal: 'quotation_has_order',
    })
  })

  it('an accepted revision becomes one order, once; extra work is a new revision', () => {
    expect(quotationActions(ctx('accepted'))).toEqual(['revise', 'copy', 'to_order'])
    expect(quotationTransition('to_order', ctx('accepted', { hasOrder: true }))).toMatchObject({
      ok: true,
      changes: false,
    })
    expect(quotationTransition('to_order', ctx('accepted', { otherHasOrder: true }))).toEqual({
      ok: false,
      refusal: 'quotation_has_order',
    })
    expect(quotationTransition('to_order', ctx('sent'))).toEqual({
      ok: false,
      refusal: 'quotation_not_accepted',
    })
    expect(quotationTransition('revise', ctx('accepted', { hasOrder: true }))).toEqual({
      ok: true,
      to: 'draft',
      changes: true,
    })
  })

  it('only the latest revision is revised or decided; a superseded one is only copied', () => {
    expect(quotationActions(ctx('superseded', { latest: false }))).toEqual(['copy'])
    expect(quotationTransition('revise', ctx('sent', { latest: false }))).toEqual({
      ok: false,
      refusal: 'quotation_superseded',
    })
    expect(quotationTransition('accept', ctx('superseded', { latest: false }))).toEqual({
      ok: false,
      refusal: 'quotation_superseded',
    })
  })

  it('every status answers every action', () => {
    for (const status of QUOTATION_STATUSES) {
      for (const action of [
        'update',
        'discard',
        'send',
        'revise',
        'accept',
        'decline',
        'copy',
        'to_order',
      ] as const) {
        expect(quotationTransition(action, ctx(status))).toHaveProperty('ok')
      }
    }
  })
})

describe('quotationListStatus', () => {
  it('a sent quotation past its validity shows as expired; valid until today is still valid', () => {
    expect(quotationListStatus('sent', '2026-10-15', '2026-10-16')).toBe('expired')
    expect(quotationListStatus('sent', '2026-10-16', '2026-10-16')).toBe('sent')
    expect(quotationListStatus('sent', null, '2026-10-16')).toBe('sent')
    expect(quotationListStatus('accepted', '2026-01-01', '2026-10-16')).toBe('accepted')
  })
})

describe('DOCUMENT_ACCENTS', () => {
  /** WCAG relative luminance of a #RRGGBB colour (a test-only number; no money here). */
  const luminance = (hex: string) => {
    const channel = (i: number) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }

  it('each accent carries white text (contrast ≥ 4.5 : 1) and is a key of the palette', () => {
    for (const [key, hex] of Object.entries(DOCUMENT_ACCENTS)) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/)
      expect(1.05 / (luminance(hex) + 0.05)).toBeGreaterThanOrEqual(4.5)
      expect(isDocumentAccent(key)).toBe(true)
    }
    expect(isDocumentAccent('pink')).toBe(false)
    expect(isDocumentAccent('toString')).toBe(false)
  })
})
