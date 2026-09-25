import { z } from 'zod'
import { zUuid } from '../primitives'
import { PROFILE_DISPLAY_NAME_MAX_LENGTH } from '../profile'
import { localeDto } from './me'

export const displayNameInput = z.string().trim().min(1).max(PROFILE_DISPLAY_NAME_MAX_LENGTH)

/** `account.updateProfile` (authed): the caller's own name and/or language. */
export const updateProfileInput = z
  .object({
    displayName: displayNameInput.optional(),
    locale: localeDto.optional(),
  })
  .refine((value) => value.displayName !== undefined || value.locale !== undefined, {
    message: 'nothing to update',
  })
export type UpdateProfileInput = z.input<typeof updateProfileInput>

/** `account.delete` (authed). The auth user is gone once this returns. */
export const deleteAccountDto = z.object({
  /** Businesses soft-deleted because the caller was their only member. */
  deletedBusinessIds: z.array(zUuid),
})
export type DeleteAccountDto = z.infer<typeof deleteAccountDto>
