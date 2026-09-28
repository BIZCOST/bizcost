import { describe, expect, it } from 'vitest'
import { checkSupplier, supplierDraft } from './supplier-draft'

// The supplier form: a name, and contact details that are optional but checked as the API checks
// them.

describe('checkSupplier', () => {
  it('needs only a name', () => {
    expect(checkSupplier({ ...supplierDraft(), name: '  Al Ain Dairy ' })).toEqual({
      errors: {},
      fields: { name: 'Al Ain Dairy', phone: null, email: null, trn: null, notes: null },
    })
    expect(checkSupplier(supplierDraft()).errors.name?.key).toBe('catalog.form.nameRequired')
  })

  it('reads a TRN and a phone typed with Arabic digits, spaces or dashes', () => {
    const checked = checkSupplier({
      ...supplierDraft(),
      name: 'محمصة الخليج',
      phone: '+٩٧١ ٤ ١٢٣-٤٥٦٧',
      trn: '100 1234 5678 9003',
      email: 'sales@roastery.ae',
    })
    expect(checked.fields).toMatchObject({
      phone: '+971 4 123-4567',
      trn: '100123456789003',
      email: 'sales@roastery.ae',
    })
  })

  it('says what is wrong with each detail', () => {
    const checked = checkSupplier({
      ...supplierDraft(),
      name: 'X',
      phone: 'call me',
      email: 'not an email',
      trn: '12345',
      notes: 'x'.repeat(1001),
    })
    expect(checked.fields).toBeNull()
    expect(checked.errors).toEqual({
      phone: { key: 'purchasing.suppliers.phoneInvalid' },
      email: { key: 'purchasing.suppliers.emailInvalid' },
      trn: { key: 'purchasing.suppliers.trnInvalid' },
      notes: { key: 'purchasing.tooLong', values: { count: 1000 } },
    })
  })

  it('opens a stored supplier as it is', () => {
    expect(
      supplierDraft({
        id: 'id',
        name: 'Al Ain Dairy',
        phone: null,
        email: 'a@b.ae',
        trn: null,
        notes: 'Mornings',
        archivedAt: null,
        version: 2,
      }),
    ).toEqual({ name: 'Al Ain Dairy', phone: '', email: 'a@b.ae', trn: '', notes: 'Mornings' })
  })
})
