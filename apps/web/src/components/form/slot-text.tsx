import type { ReactNode } from 'react'

/** Marks where a rendered value goes in a translated sentence (never part of a message). */
export const SLOT = '\u0000'

/**
 * A message translated with `SLOT` as one of its values (`t(key, { name: SLOT })`), that value
 * rendered as `value`: e.g. Latin text in a left-to-right isolate inside an Arabic sentence.
 */
export function SlotText({ text, value }: { text: string; value: ReactNode }) {
  const [before = '', after = ''] = text.split(SLOT)
  return (
    <>
      {before}
      {value}
      {after}
    </>
  )
}
