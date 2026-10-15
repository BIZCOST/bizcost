import { describe, expect, it } from 'vitest'
import { customerMayHaveLicence, phoneLast4 } from './keys'

// Customers (M3 Step 5, Q2): a member who may not see customers tells two "Ahmed"s apart by the
// phone's last 4 digits only; a trade licence goes with a business or a government customer.

describe('phoneLast4', () => {
  it('keeps the last 4 digits of a number as typed, Arabic-Indic digits too', () => {
    expect(phoneLast4('050 123 4567')).toBe('4567')
    expect(phoneLast4('+971 (50) 123-4567')).toBe('4567')
    expect(phoneLast4('٠٥٠١٢٣٤٥٦٧')).toBe('4567')
  })

  it('says nothing for a number of fewer than 4 digits, or none', () => {
    expect(phoneLast4('123')).toBeNull()
    expect(phoneLast4(null)).toBeNull()
  })
})

describe('customerMayHaveLicence', () => {
  it('a business or a government customer, never a person', () => {
    expect(customerMayHaveLicence('business')).toBe(true)
    expect(customerMayHaveLicence('government')).toBe(true)
    expect(customerMayHaveLicence('individual')).toBe(false)
  })
})
