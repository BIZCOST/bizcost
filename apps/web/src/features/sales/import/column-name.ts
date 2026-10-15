import { columnLetter } from './wizard'

/** Wraps a value so it reads in its own direction inside the sentence (FSI … PDI). */
const isolate = (value: string) => `\u2068${value}\u2069`

/**
 * A file's column as a message names it (a row left out, M3 Step 4): its letter, and its header after
 * it ("E (Item)"), each read in its own direction, so an Arabic header never comes before the letter
 * in an Arabic sentence. Shared by the sales importer and the statement file.
 */
export function columnName(index: number, header: string | undefined): string {
  return header ? `${isolate(columnLetter(index))} (${isolate(header)})` : columnLetter(index)
}
