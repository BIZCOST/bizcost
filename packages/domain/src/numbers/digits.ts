// Users may type Arabic-Indic (٠-٩) or Extended Arabic-Indic / Persian (۰-۹) digits.
// Everything stored and computed uses ASCII digits.

const ARABIC_INDIC_ZERO = 0x0660
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0

/** Converts Arabic-Indic and Extended Arabic-Indic digits to ASCII 0-9. Other characters are kept. */
export function normalizeDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0)
    const zero = code >= EXTENDED_ARABIC_INDIC_ZERO ? EXTENDED_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO
    return String(code - zero)
  })
}
