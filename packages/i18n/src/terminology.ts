import type { TerminologyProfile } from '@bizcost/domain'
import type { I18nKey } from './types'

/**
 * Terminology overlays (docs/ARCHITECTURE.md §i18n & RTL, PRODUCT.md §6.9): a profile replaces a whole
 * message with `<key>_<profile>` in the same namespace, e.g. `modules.materials.name_food`
 * ("Ingredients") for `modules.materials.name` ("Materials"). Returns the overlay's key when the
 * profile has one, else `key`. Nouns are never interpolated into sentences. i18next resolves the same
 * messages with `t(key, { context: profile })`; this helper keeps the key typed.
 *
 * `has` says whether a key has a message: `(k) => hasKey(i18n, k)` with the page's instance (the
 * browser holds only some namespaces), or `(k) => hasMessage('en', k)` where every message is at hand
 * (both languages have the same keys, messages.test.ts).
 */
export function terminologyKey(
  key: I18nKey,
  profile: TerminologyProfile | null | undefined,
  has: (key: string) => boolean,
): I18nKey {
  if (!profile) return key
  const overlay = `${key}_${profile}`
  return has(overlay) ? (overlay as I18nKey) : key
}
