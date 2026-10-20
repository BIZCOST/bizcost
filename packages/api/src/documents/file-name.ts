/**
 * A name as a part of a downloaded file's name (a customer's statement, Release B review): its
 * letters and digits in any script (an Arabic name keeps its Arabic, «Café» its «é»), with runs of
 * anything else (spaces, punctuation, the characters no file system takes, direction marks) as one
 * "-", at most `max` characters; `fallback` when nothing is left.
 */
export function fileNamePart(text: string, fallback: string, max = 60): string {
  const part = text
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  const cut = [...part].slice(0, max).join('').replace(/-+$/, '')
  return cut || fallback
}
