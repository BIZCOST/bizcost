import { hasMessage, pickMessages, type Messages } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import { depositHintKey } from './deposit-hint'

// A business not registered for VAT sees no VAT, on the bill dialog's deposit hint too (it read "takes
// the deposit off before VAT" to everyone, in both languages).

function billOf(locale: 'en' | 'ar'): Messages {
  const documents = pickMessages(locale, ['documents']).documents as Messages
  return (documents.invoices as Messages).bill as Messages
}

describe('the deposit hint of the bill dialog', () => {
  it('says how VAT is charged to a VAT-registered business', () => {
    expect(depositHintKey(true)).toBe('documents.invoices.bill.depositHint')
    expect(String(billOf('en').depositHint)).toMatch(/VAT/)
    expect(String(billOf('ar').depositHint)).toMatch(/الضريبة/)
  })

  it('says nothing of tax to a business not registered for VAT, in both languages', () => {
    const key = depositHintKey(false)
    expect(key).toBe('documents.invoices.bill.depositHintPlain')
    for (const locale of ['en', 'ar'] as const) {
      expect(hasMessage(locale, key)).toBe(true)
      const words = String(billOf(locale).depositHintPlain)
      expect(words).not.toMatch(/VAT|tax/i)
      expect(words).not.toMatch(/ضريب/)
    }
  })
})
