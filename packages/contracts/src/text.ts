// Text rules shared by the API schemas (dto/*) and the app forms. No Zod here, so a client that needs
// only the rule does not bundle the API schemas.

/**
 * Control characters (C0, DEL and C1, e.g. a tab or U+0000): never part of a one-line name, and
 * Postgres text cannot hold U+0000 at all. The API refuses a name that has one (VALIDATION).
 */
export const CONTROL_CHARACTER = /\p{Cc}/u

/** A name as typed or pasted, with each run of control characters (e.g. a pasted tab) as a space. */
export function withoutControlCharacters(value: string): string {
  return value.replace(/\p{Cc}+/gu, ' ')
}
