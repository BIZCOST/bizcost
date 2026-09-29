import type { Locale } from '@bizcost/domain'
import { formatList } from '@bizcost/i18n'
import { isolate } from '@/components/form/use-message'

// Names of records said in a sentence ("Spanish Latte, Iced Latte and Mocha"): each isolated in its
// own direction (an English name in an Arabic sentence), joined the page language's way.

/** "A, B and C" (English), «A وB وC» (Arabic). */
export function listOfNames(locale: Locale, names: readonly string[]): string {
  return formatList(
    locale,
    names.map((name) => isolate(name)),
  )
}
