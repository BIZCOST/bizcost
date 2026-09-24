import { describe, expect, it } from 'vitest'
import { parseTrn } from './trn'

describe('parseTrn', () => {
  it('accepts 15 ASCII digits', () => {
    expect(parseTrn('100123456700003')).toEqual({ ok: true, value: '100123456700003' })
  })

  it('accepts Arabic digits, spaces, dashes and direction marks', () => {
    expect(parseTrn('١٠٠-١٢٣٤ ٥٦٧٠ ٠٠٠٣')).toEqual({ ok: true, value: '100123456700003' })
    expect(parseTrn('‎100 1234 5670 0003‏')).toEqual({ ok: true, value: '100123456700003' })
  })

  it('rejects empty input', () => {
    expect(parseTrn('  ')).toEqual({ ok: false, error: 'required' })
  })

  it('rejects letters and symbols', () => {
    expect(parseTrn('10012345670000A')).toEqual({ ok: false, error: 'invalid_chars' })
  })

  it('rejects wrong length', () => {
    expect(parseTrn('10012345670000')).toEqual({ ok: false, error: 'invalid_length' })
    expect(parseTrn('1001234567000030')).toEqual({ ok: false, error: 'invalid_length' })
  })
})
