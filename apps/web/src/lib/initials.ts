/** Arabic script: one letter (a second word often starts with the article ال). */
const ARABIC = /[؀-ۿ]/

/** Initials for avatars: first and last word, or one letter for Arabic names. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const words =
    parts.length > 1 && !ARABIC.test(name) ? [parts[0], parts.at(-1)] : parts.slice(0, 1)
  return words
    .map((word) => (word ? (Array.from(word)[0] ?? '') : ''))
    .join('')
    .toLocaleUpperCase()
}
