import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { readImportFile } from './read-file'

// ADVERSARY (M3 Step 4, D-252): a spreadsheet is expanded by the range its sheet DECLARES
// (`<dimension ref>`), not by the cells it holds. readWorkbook reads with `dense: true` and
// sheet_to_json with `defval: null, blankrows: true` and no `nodim` / `sheetRows`, so a few KB of
// .xlsx come back as 1,048,576 rows, and a 222 KB file of 20,000 one-cell rows declaring A1:XFD20001
// as 20,000 × 16,384 cells (3.7 GB of heap in Node, measured): the tab freezes or dies on the main
// thread before the 25 MB cap or the 100,000-row limit is ever checked. This FAILS on the code as built.

/** A .xlsx of `cells` whose sheet1.xml declares `ref` as its dimension (as a hostile export may). */
function workbookDeclaring(cells: (string | number)[][], ref: string): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(cells)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Sales')
  const written = new Uint8Array(
    XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
  )
  const zip = XLSX.CFB.read(written, { type: 'array' })
  const index = zip.FullPaths.findIndex((path: string) => path.endsWith('xl/worksheets/sheet1.xml'))
  const entry = zip.FileIndex[index]!
  const xml = new TextDecoder()
    .decode(entry.content as Uint8Array)
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${ref}"/>`)
  entry.content = new TextEncoder().encode(xml) as unknown as typeof entry.content
  entry.size = (entry.content as Uint8Array).length
  return new Uint8Array(
    XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' }) as ArrayLike<number>,
  )
}

describe('readImportFile and a declared sheet range', () => {
  it('reads the cells a sheet holds, not the 1,048,576 × 16,384 it claims', async () => {
    const bytes = workbookDeclaring(
      [
        ['Item', 'Qty', 'Total'],
        ['Latte', 1, 18],
      ],
      'A1:XFD1048576',
    )
    expect(bytes.length).toBeLessThan(20_000) // a few KB
    const file = new File([bytes as BlobPart], 'pos.xlsx')
    const read = await readImportFile(file)
    // Today: 1,048,576 rows (and 16,384 cells in each row that holds one).
    expect(read.rows.length).toBeLessThanOrEqual(2)
    expect(Math.max(...read.rows.map((r) => r.length))).toBeLessThanOrEqual(3)
  })
})
