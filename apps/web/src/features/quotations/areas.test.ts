import { describe, expect, it } from 'vitest'
import {
  addLineTo,
  areaTaken,
  canMoveArea,
  canMoveLine,
  moveArea,
  moveLine,
  renameArea,
  setLineArea,
} from './areas'

// The editor's areas (D-299): every move keeps each area's lines together, as the PDF prints them.

const l = (id: string, area: string | null = null) => ({ id, area })
const show = (lines: readonly { id: string; area: string | null }[]) =>
  lines.map((line) => (line.area ? `${line.area}:${line.id}` : line.id)).join(' ')

// المجلس: 1 2 3 · 4 (no area) · غرفة النوم: 5 6
const fitOut = [
  l('1', 'المجلس'),
  l('2', 'المجلس'),
  l('3', 'المجلس'),
  l('4'),
  l('5', 'غرفة النوم'),
  l('6', 'غرفة النوم'),
]

describe('moveLine', () => {
  it('moves a line inside its area, never out of it', () => {
    expect(show(moveLine(fitOut, '2', -1))).toBe(
      'المجلس:2 المجلس:1 المجلس:3 4 غرفة النوم:5 غرفة النوم:6',
    )
    expect(canMoveLine(fitOut, '1', -1)).toBe(false)
    expect(canMoveLine(fitOut, '3', 1)).toBe(false)
    expect(moveLine(fitOut, '3', 1)).toEqual(fitOut)
  })

  it('moves a line without an area past the whole area beside it', () => {
    expect(show(moveLine(fitOut, '4', -1))).toBe(
      '4 المجلس:1 المجلس:2 المجلس:3 غرفة النوم:5 غرفة النوم:6',
    )
    expect(show(moveLine(fitOut, '4', 1))).toBe(
      'المجلس:1 المجلس:2 المجلس:3 غرفة النوم:5 غرفة النوم:6 4',
    )
  })
})

describe('moveArea', () => {
  it('moves an area with its lines past the block beside it', () => {
    expect(show(moveArea(fitOut, 'غرفة النوم', -1))).toBe(
      'المجلس:1 المجلس:2 المجلس:3 غرفة النوم:5 غرفة النوم:6 4',
    )
    expect(show(moveArea(fitOut, 'المجلس', 1))).toBe(
      '4 المجلس:1 المجلس:2 المجلس:3 غرفة النوم:5 غرفة النوم:6',
    )
    expect(canMoveArea(fitOut, 'المجلس', -1)).toBe(false)
    expect(canMoveArea(fitOut, 'غرفة النوم', 1)).toBe(false)
  })
})

describe('setLineArea, an area started with an empty line (D-299)', () => {
  // Three lines typed, then "Add an area" (Kitchen) started with an empty line (e).
  const typed = [l('a'), l('b'), l('c'), l('e', 'Kitchen')]
  const blank = (line: { id: string }) => line.id === 'e'

  it('drops the empty line once a typed line goes in: the count is the lines put in', () => {
    const one = setLineArea(typed, 'a', 'Kitchen', blank)
    expect(show(one)).toBe('b c Kitchen:a')
    const all = setLineArea(setLineArea(one, 'b', 'Kitchen', blank), 'c', 'Kitchen', blank)
    expect(show(all)).toBe('Kitchen:a Kitchen:b Kitchen:c')
  })

  it('keeps an empty line beside a line already in the area, and without the check', () => {
    const started = [l('a'), l('k', 'Kitchen'), l('e', 'Kitchen')]
    expect(show(setLineArea(started, 'a', 'Kitchen', blank))).toBe('Kitchen:k Kitchen:e Kitchen:a')
    expect(show(setLineArea(typed, 'a', 'Kitchen'))).toBe('b c Kitchen:e Kitchen:a')
    // Out of any area, nothing else changes.
    expect(show(setLineArea(typed, 'e', null, blank))).toBe('a b c e')
  })
})

describe('setLineArea', () => {
  it('moves a line to the end of another area', () => {
    expect(show(setLineArea(fitOut, '1', 'غرفة النوم'))).toBe(
      'المجلس:2 المجلس:3 4 غرفة النوم:5 غرفة النوم:6 غرفة النوم:1',
    )
    expect(show(setLineArea(fitOut, '4', 'المجلس'))).toBe(
      'المجلس:1 المجلس:2 المجلس:3 المجلس:4 غرفة النوم:5 غرفة النوم:6',
    )
  })

  it('takes a line out of its area, just after it', () => {
    expect(show(setLineArea(fitOut, '2', null))).toBe(
      'المجلس:1 المجلس:3 2 4 غرفة النوم:5 غرفة النوم:6',
    )
  })

  it('starts a new area where the line was, or just after the area it leaves', () => {
    expect(show(setLineArea(fitOut, '4', 'Pantry'))).toBe(
      'المجلس:1 المجلس:2 المجلس:3 Pantry:4 غرفة النوم:5 غرفة النوم:6',
    )
    expect(show(setLineArea(fitOut, '1', 'Pantry'))).toBe(
      'المجلس:2 المجلس:3 Pantry:1 4 غرفة النوم:5 غرفة النوم:6',
    )
  })

  it('an area emptied is gone; the same area changes nothing', () => {
    const one = [l('1', 'A'), l('2', 'B')]
    expect(show(setLineArea(one, '1', 'B'))).toBe('B:2 B:1')
    expect(setLineArea(fitOut, '1', 'المجلس')).toEqual(fitOut)
    expect(setLineArea(fitOut, '4', null)).toEqual(fitOut)
  })

  it('an area named differently but read the same is that area, in its spelling', () => {
    const lines = [l('1', 'Majlis'), l('2')]
    expect(show(setLineArea(lines, '2', ' majlis '))).toBe('Majlis:1 Majlis:2')
  })
})

describe('renameArea, addLineTo, areaTaken', () => {
  it('renames every line of the area', () => {
    expect(show(renameArea(fitOut, 'المجلس', 'Majlis'))).toBe(
      'Majlis:1 Majlis:2 Majlis:3 4 غرفة النوم:5 غرفة النوم:6',
    )
  })

  it('adds a line at the end of its area, or at the end of the quotation', () => {
    expect(show(addLineTo(fitOut, l('7'), 'المجلس'))).toBe(
      'المجلس:1 المجلس:2 المجلس:3 المجلس:7 4 غرفة النوم:5 غرفة النوم:6',
    )
    expect(show(addLineTo(fitOut, l('7'), null))).toBe(
      'المجلس:1 المجلس:2 المجلس:3 4 غرفة النوم:5 غرفة النوم:6 7',
    )
    expect(show(addLineTo(fitOut, l('7'), 'Pantry'))).toBe(
      'المجلس:1 المجلس:2 المجلس:3 4 غرفة النوم:5 غرفة النوم:6 Pantry:7',
    )
  })

  it('knows an area name already used (but the one renamed)', () => {
    expect(areaTaken(fitOut, ' المجلس')).toBe(true)
    expect(areaTaken(fitOut, 'Pantry')).toBe(false)
    expect(areaTaken(fitOut, 'المجلس', 'المجلس')).toBe(false)
  })
})
