import { z } from 'zod'
import { BUSINESS_NAME_MAX_LENGTH, LOGO_CONTENT_TYPES } from '../business'
import { zUuid } from '../primitives'
import { CONTROL_CHARACTER } from '../text'
import { businessNameInput } from './business-setup'
import { localeDto } from './me'

// Settings → Business profile, language and Customize BizCost (ROADMAP.md Step 6).

/** `business.profile` (settings.business.view): the business's legal and tax details. */
export const businessProfileDto = z.object({
  id: zUuid,
  legalName: z.string(),
  /** Arabic legal name (tax invoices); null when not given. */
  legalNameAr: z.string().nullable(),
  /** A signed download URL of the logo, valid for LOGO_URL_TTL_SECONDS; null without a logo. */
  logoUrl: z.string().nullable(),
  /** ISO-4217 (AED in M1, read-only). */
  currency: z.string(),
  /** ISO-3166 alpha-2 (AE in M1, read-only). */
  country: z.string(),
  /** IANA time zone (Asia/Dubai in M1, read-only). */
  timezone: z.string(),
  vatRegistered: z.boolean(),
  /** 15 digits, only when VAT registered. */
  trn: z.string().nullable(),
  /** The business's language: names of new defaults and the default language of invitations. */
  defaultLocale: localeDto,
  /** For optimistic concurrency: send it back with updateProfile. */
  version: z.int().positive(),
})
export type BusinessProfileDto = z.infer<typeof businessProfileDto>

/** An optional one-line name: '' means none (null). */
const optionalNameInput = z
  .string()
  .trim()
  .max(BUSINESS_NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })
  .nullable()

/**
 * `business.updateProfile` (settings.business.edit): the whole profile form. The TRN is required
 * exactly when the business is VAT registered; it may be typed with spaces, dashes or Arabic digits
 * (the server checks it with parseTrn and stores the 15 digits). `version` is the profile's version
 * as read: another change in between is CONFLICT.
 */
export const updateBusinessProfileInput = z.object({
  version: z.int().positive(),
  legalName: businessNameInput,
  legalNameAr: optionalNameInput,
  vatRegistered: z.boolean(),
  trn: z.string().max(40).nullable(),
})
export type UpdateBusinessProfileInput = z.input<typeof updateBusinessProfileInput>

/**
 * `business.updateProfile`: the saved profile, and the modules switching VAT turned on or off with it
 * (the Customize BizCost rules: VAT on brings VAT Center, and Invoices when Orders is on; VAT off turns
 * off what needs it).
 */
export const updateBusinessProfileDto = z.object({
  profile: businessProfileDto,
  turnedOn: z.array(z.string()),
  turnedOff: z.array(z.string()),
})
export type UpdateBusinessProfileDto = z.infer<typeof updateBusinessProfileDto>

/** `business.setDefaultLocale` (settings.business.edit). */
export const setDefaultLocaleInput = z.object({ defaultLocale: localeDto })
export type SetDefaultLocaleInput = z.input<typeof setDefaultLocaleInput>

/** `business.logoUploadUrl` (settings.business.edit): the type of the image to upload. */
export const logoUploadUrlInput = z.object({ contentType: z.enum(LOGO_CONTENT_TYPES) })
export type LogoUploadUrlInput = z.input<typeof logoUploadUrlInput>

/**
 * A signed upload URL for one new logo object. Upload the file with `PUT uploadUrl` (or supabase-js
 * `uploadToSignedUrl(path, token, file)`) and the same content type, then call `business.setLogo`
 * with `path`. The bucket refuses files over `maxBytes` and other types.
 */
export const logoUploadUrlDto = z.object({
  path: z.string(),
  uploadUrl: z.string(),
  token: z.string(),
  maxBytes: z.int().positive(),
})
export type LogoUploadUrlDto = z.infer<typeof logoUploadUrlDto>

/** `business.setLogo` (settings.business.edit): the uploaded object's path, from logoUploadUrl. */
export const setLogoInput = z.object({ path: z.string().min(1).max(200) })
export type SetLogoInput = z.input<typeof setLogoInput>

/** A switch of Customize BizCost: a module, or a capability. */
export const businessItemDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('module'), id: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('capability'), key: z.string().min(1).max(40) }),
])
export type BusinessItemDto = z.infer<typeof businessItemDto>

/** One module of Customize BizCost (Dashboard and Settings are never listed: always on). */
export const customizeModuleDto = z.object({
  id: z.string(),
  kind: z.enum(['core', 'optional']),
  /** Planned modules are saved and appear by themselves once released (the review's wording). */
  availability: z.enum(['released', 'planned']),
  enabled: z.boolean(),
})
export type CustomizeModuleDto = z.infer<typeof customizeModuleDto>

/** `business.customization` (settings.modules.manage). */
export const customizationDto = z.object({
  modules: z.array(customizeModuleDto),
  /** Every capability of the registry → on/off (vat_registered is switched in the profile). */
  capabilities: z.record(z.string(), z.boolean()),
  /** The team still has other members or pending invitations: has_team cannot be turned off. */
  teamInUse: z.boolean(),
  /** The business has more than one location: multi_location cannot be turned off. */
  locationsInUse: z.boolean(),
})
export type CustomizationDto = z.infer<typeof customizationDto>

/** `business.customize` (settings.modules.manage): one switch, with the review's dependency rules. */
export const customizeInput = z.object({ item: businessItemDto, enabled: z.boolean() })
export type CustomizeInput = z.input<typeof customizeInput>

/** The new state and the side effects ("Also turned on:" / "Also turned off:"). */
export const customizeDto = z.object({
  customization: customizationDto,
  turnedOn: z.array(businessItemDto),
  turnedOff: z.array(businessItemDto),
})
export type CustomizeDto = z.infer<typeof customizeDto>
