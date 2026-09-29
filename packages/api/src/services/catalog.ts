import { createHash } from 'node:crypto'
import { isUuid } from '@bizcost/domain'
import { constraintOf, sqlStateOf, AppError } from '../errors'

// Shared by the Materials and Products & Services services (M2 Step 2): list pages ordered by name
// with an opaque cursor, name search, idempotency fingerprints and the "name taken" answer.

/** Where the next page starts: the last row's sort key (the database's lower(name)) and id. */
interface Cursor {
  readonly key: string
  readonly id: string
}

/** The cursor of the row a page ended with (base64url JSON; clients pass it back unchanged). */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.id]), 'utf8').toString('base64url')
}

/** A cursor as a client sent it; anything this server did not make is VALIDATION. */
export function decodeCursor(value: string): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new AppError('validation', { message: 'invalid cursor' })
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !isUuid(parsed[1])
  ) {
    throw new AppError('validation', { message: 'invalid cursor' })
  }
  return { key: parsed[0], id: parsed[1] }
}

/** An ILIKE pattern that finds `search` anywhere in a name (%, _ and \ taken literally). */
export function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** SHA-256 fingerprint of a create payload (DATA_MODEL.md §1.2, idempotent creates). */
export function requestHashOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Runs a write; a unique violation of `constraint` (another record of the business already has the
 * name) becomes NAME_TAKEN instead of a plain CONFLICT. An item bought ready to sell writes two names
 * (its product's and its material's, D-117): pass both constraints.
 */
export async function withUniqueName<T>(
  constraint: string | readonly string[],
  write: () => Promise<T>,
): Promise<T> {
  const names: readonly string[] = typeof constraint === 'string' ? [constraint] : constraint
  try {
    return await write()
  } catch (error) {
    const violated = constraintOf(error)
    if (sqlStateOf(error) === '23505' && violated !== undefined && names.includes(violated)) {
      throw new AppError('name_taken', { cause: error })
    }
    throw error
  }
}
