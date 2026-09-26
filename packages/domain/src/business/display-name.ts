import type { Locale } from '../tenancy/keys'

// The name BizCost shows for a business (D-097): the Arabic legal name (businesses.legal_name_ar)
// in the Arabic app when the business has one, else the legal name. The English app always shows
// the legal name. Every place that shows a business's name (the app shell, pages, page titles, the
// invitation page and email) goes through this one rule.

/** A business's two legal names, as the API returns them. */
export interface BusinessNames {
  readonly legalName: string
  /** Optional; null or blank when the business has no Arabic name. */
  readonly legalNameAr?: string | null
}

export function businessDisplayName(names: BusinessNames, locale: Locale): string {
  const arabic = names.legalNameAr?.trim() ?? ''
  return locale === 'ar' && arabic !== '' ? arabic : names.legalName
}
