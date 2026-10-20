import { describe, expect, it } from 'vitest'
import { fileNamePart } from './file-name'

describe('fileNamePart', () => {
  it('keeps a name in any script, so two customers’ statements never download under one name', () => {
    expect(fileNamePart('فاطمة المنصوري', 'customer')).toBe('فاطمة-المنصوري')
    expect(fileNamePart('مجموعة الريم العقارية', 'customer')).toBe('مجموعة-الريم-العقارية')
    expect(fileNamePart('Brew & Co. Café', 'customer')).toBe('Brew-Co-Café')
    expect(fileNamePart('Gulf Realty', 'customer')).toBe('Gulf-Realty')
  })

  it('takes out what a file system refuses, direction marks and spaces at the ends', () => {
    expect(fileNamePart(' a/b\\c:d*e?"f<g>h|i ', 'x')).toBe('a-b-c-d-e-f-g-h-i')
    // An isolate around a name and a right-to-left mark before a word (U+2067, U+2069, U+200F).
    const marked = `${String.fromCodePoint(0x2067)}سعيد${String.fromCodePoint(0x2069)} ${String.fromCodePoint(0x200f)}بن حارب`
    expect(fileNamePart(marked, 'x')).toBe('سعيد-بن-حارب')
    expect(fileNamePart('../..', 'customer')).toBe('customer')
    expect(fileNamePart('', 'customer')).toBe('customer')
  })

  it('stays short', () => {
    expect([...fileNamePart('ب'.repeat(200), 'x')]).toHaveLength(60)
    expect(fileNamePart(`${'a'.repeat(59)} b`, 'x')).toBe('a'.repeat(59))
  })
})
