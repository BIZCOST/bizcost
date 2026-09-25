import type { TerminologyProfile } from '@bizcost/domain'
import { FALLBACK_LOCALE, hasMessage } from './resources'
import type { I18nKey } from './types'

/**
 * Terminology overlays (docs/ARCHITECTURE.md §i18n & RTL, PRODUCT.md §6.9): a profile replaces a whole
 * message with `<key>_<profile>` in the same namespace, e.g. `modules.materials.name_food`
 * ("Ingredients") for `modules.materials.name` ("Materials"). Returns the overlay's key when the
 * profile has one, else `key`. Nouns are never interpolated into sentences. i18next resolves the same
 * messages with `t(key, { context: profile })`; this helper keeps the key typed.
 */
export function terminologyKey(
  key: I18nKey,
  profile: TerminologyProfile | null | undefined,
): I18nKey {
  if (!profile) return key
  const overlay = `${key}_${profile}`
  // Both languages have the same keys (messages.test.ts), so English decides.
  return hasMessage(FALLBACK_LOCALE, overlay) ? (overlay as I18nKey) : key
}
