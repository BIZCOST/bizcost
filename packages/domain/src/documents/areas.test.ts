import { describe, expect, it } from 'vitest'
import { areaBlocks, areaKey, areaNames, groupByArea } from './areas'

// A quotation's areas (D-299): each area's lines together, in the order the owner put them, so the
// PDF's area cell spans exactly its lines.

const line = (id: string, area: string | null) => ({ id, area })
const ids = (lines: readonly { id: string }[]) => lines.map((l) => l.id)

describe('areaKey', () => {
  it('reads two spellings of one name as one area', () => {
    expect(areaKey('  Master   BR ')).toBe(areaKey('master br'))
    expect(areaKey('المجلس')).toBe(areaKey(' المجلس '))
    // NFC: a precomposed letter and a letter with its combining mark are one name.
    expect(areaKey('Café')).toBe(areaKey('Café'))
    expect(areaKey('Room 1')).not.toBe(areaKey('Room 2'))
  })
})

describe('groupByArea', () => {
  it('brings each area’s lines together, in the order each area first comes', () => {
    const lines = [line('a1', 'A'), line('n1', null), line('b1', 'B'), line('a2', 'A')]
    expect(ids(groupByArea(lines))).toEqual(['a1', 'a2', 'n1', 'b1'])
  })

  it('keeps the order of the lines inside an area and of the lines without one', () => {
    const lines = [
      line('n1', null),
      line('b1', 'B'),
      line('a1', 'A'),
      line('b2', 'B'),
      line('n2', null),
      line('a2', 'A'),
      line('b3', 'B'),
    ]
    expect(ids(groupByArea(lines))).toEqual(['n1', 'b1', 'b2', 'b3', 'a1', 'a2', 'n2'])
  })

  it('leaves lines already in order as they are (the same objects)', () => {
    const lines = [line('a1', 'A'), line('a2', 'A'), line('n1', null), line('b1', 'B')]
    const grouped = groupByArea(lines)
    expect(grouped).toEqual(lines)
    grouped.forEach((l, i) => expect(l).toBe(lines[i]))
    expect(groupByArea([])).toEqual([])
  })

  it('gives every line of an area its first line’s spelling', () => {
    const grouped = groupByArea([line('a1', 'Majlis'), line('b1', 'Pantry'), line('a2', 'MAJLIS ')])
    expect(grouped).toEqual([line('a1', 'Majlis'), line('a2', 'Majlis'), line('b1', 'Pantry')])
  })

  it('takes an empty area as none', () => {
    expect(ids(groupByArea([line('a1', 'A'), line('e', '  '), line('a2', 'A')]))).toEqual([
      'a1',
      'a2',
      'e',
    ])
  })

  it('is stable: grouping twice changes nothing more', () => {
    const lines = [
      line('b1', 'B'),
      line('a1', 'A'),
      line('n', null),
      line('b2', 'b'),
      line('a2', 'A'),
    ]
    const once = groupByArea(lines)
    expect(groupByArea(once)).toEqual(once)
  })
})

describe('areaBlocks', () => {
  it('is one block per area run, and one per line without an area', () => {
    const blocks = areaBlocks([
      line('a1', 'A'),
      line('a2', 'a'),
      line('n1', null),
      line('n2', null),
      line('b1', 'B'),
    ])
    expect(blocks.map((b) => [b.area, ids(b.lines)])).toEqual([
      ['A', ['a1', 'a2']],
      [null, ['n1']],
      [null, ['n2']],
      ['B', ['b1']],
    ])
  })
})

describe('areaNames', () => {
  it('lists each area once, as first spelled, in order', () => {
    expect(
      areaNames([line('1', 'B'), line('2', null), line('3', 'A'), line('4', 'b'), line('5', '')]),
    ).toEqual(['B', 'A'])
  })
})
