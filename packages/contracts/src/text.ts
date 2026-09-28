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

/**
 * Characters that never show and never change how a name reads (zero-width space, word joiner, the
 * byte-order mark, soft hyphen, Mongolian vowel separator). A catalog name drops them, so "Sugar" and
 * "Sugar" with a zero-width space are one name (D-131).
 */
const INVISIBLE = /[\u00AD\u180E\u200B\u2060\uFEFF]/gu

/**
 * Spaces and marks that show nothing at the ends of a name: whitespace, the joiners and bidi marks
 * (U+061C, U+200C to U+200F, U+202A to U+202E, U+2066 to U+2069). Inside a name they stay: Arabic and
 * Persian text and emoji may need them.
 */
const FILLER_AT_ENDS =
  /^[\s\u061C\u200C-\u200F\u202A-\u202E\u2066-\u2069]+|[\s\u061C\u200C-\u200F\u202A-\u202E\u2066-\u2069]+$/gu

/**
 * A catalog name as it is stored (materials, products and services, packs; D-131): invisible
 * characters removed, then spaces and marks trimmed from both ends. Control characters are refused
 * by the API, so a form replaces them first (withoutControlCharacters).
 */
export function cleanName(value: string): string {
  return value.replace(INVISIBLE, '').replace(FILLER_AT_ENDS, '')
}

/** Whether a name has something to see: a character that is neither a space nor a format mark. */
export function hasVisibleCharacter(value: string): boolean {
  return /[^\s\p{Cf}]/u.test(value)
}
