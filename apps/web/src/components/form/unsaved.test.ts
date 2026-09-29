import { describe, expect, it } from 'vitest'
import { leavingTo, sameData } from './unsaved'

describe('sameData', () => {
  it('compares plain form states by value', () => {
    expect(
      sameData(
        { name: 'Milk', packs: [{ id: 'a', qty: '12' }] },
        { name: 'Milk', packs: [{ id: 'a', qty: '12' }] },
      ),
    ).toBe(true)
    expect(sameData({ name: 'Milk' }, { name: 'Milk ' })).toBe(false)
    expect(sameData({ lines: ['a', 'b'] }, { lines: ['b', 'a'] })).toBe(false)
    expect(sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it('treats a missing key and an undefined one alike', () => {
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  })

  it('compares sets by their members, files by identity', () => {
    expect(sameData(new Set(['x', 'y']), new Set(['y', 'x']))).toBe(true)
    expect(sameData(new Set(['x']), new Set(['x', 'y']))).toBe(false)
    const file = new Blob(['a'])
    expect(sameData([file], [file])).toBe(true)
    expect(sameData([file], [new Blob(['a'])])).toBe(false)
  })

  it('never takes null, an array or an object for one another', () => {
    expect(sameData(null, {})).toBe(false)
    expect(sameData([], {})).toBe(false)
    expect(sameData('', null)).toBe(false)
  })
})

describe('leavingTo', () => {
  const here = 'http://localhost:3000/b/1/purchases/new'
  const click = { target: '', download: false, modified: false }

  it('is the other page of the app a link opens', () => {
    expect(leavingTo({ ...click, href: 'http://localhost:3000/b/1/materials' }, here)).toBe(
      '/b/1/materials',
    )
    expect(leavingTo({ ...click, href: '/b/1/purchases?status=draft' }, here)).toBe(
      '/b/1/purchases?status=draft',
    )
  })

  it('is null for a hash on the same page, another tab, a download or another site', () => {
    expect(leavingTo({ ...click, href: `${here}#main` }, here)).toBeNull()
    expect(leavingTo({ ...click, href: '/b/1/materials', target: '_blank' }, here)).toBeNull()
    expect(leavingTo({ ...click, href: '/b/1/materials', modified: true }, here)).toBeNull()
    expect(leavingTo({ ...click, href: '/receipt.pdf', download: true }, here)).toBeNull()
    expect(leavingTo({ ...click, href: 'https://example.com/' }, here)).toBeNull()
  })
})
