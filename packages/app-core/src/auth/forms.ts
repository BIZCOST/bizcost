import {
  AUTH_OTP_LENGTH,
  AUTH_PASSWORD_MAX_BYTES,
  AUTH_PASSWORD_MIN_LENGTH,
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
} from '@bizcost/contracts'
import { hasMessage, type I18nKey } from '@bizcost/i18n'
import * as z from 'zod/mini'
import { normalizeCode } from './code'

// Zod schemas for the auth and account forms (react-hook-form + zodResolver). Every message is an
// i18n key; `formMessage` turns a field error into the key and values to translate. They run in the
// browser, so they use `zod/mini` (tree-shakable, no bundled locales); the API keeps classic Zod.

const utf8 = new TextEncoder()

export const emailSchema = z.pipe(
  z
    .string()
    .check(z.trim(), z.toLowerCase(), z.minLength(1, { error: 'auth.validation.emailRequired' })),
  z.email({ error: 'auth.validation.emailInvalid' }),
)

/** The password typed to sign in: only required (the server checks it). */
export const passwordSchema = z
  .string()
  .check(z.minLength(1, { error: 'auth.validation.passwordRequired' }))

/** A new password: Supabase's minimum length and bcrypt's 72-byte limit. */
export const newPasswordSchema = z.string().check(
  z.minLength(AUTH_PASSWORD_MIN_LENGTH, { error: 'auth.validation.passwordTooShort' }),
  z.refine((value: string) => utf8.encode(value).length <= AUTH_PASSWORD_MAX_BYTES, {
    error: 'auth.validation.passwordTooLong',
  }),
)

/** An email code: Arabic-Indic digits and pasted text are normalized first. */
export const codeSchema = z.pipe(
  z.pipe(z.string(), z.transform(normalizeCode)),
  z.string().check(z.length(AUTH_OTP_LENGTH, { error: 'auth.validation.codeIncomplete' })),
)

/** A code and a new password typed twice. */
const codeAndNewPasswordSchema = z
  .object({ code: codeSchema, password: newPasswordSchema, confirmPassword: z.string() })
  .check(
    z.refine(
      (value: { password: string; confirmPassword: string }) =>
        value.password === value.confirmPassword,
      { error: 'auth.validation.passwordsDontMatch', path: ['confirmPassword'] },
    ),
  )

export const signInSchema = z.object({ email: emailSchema, password: passwordSchema })
export const signUpSchema = z.object({ email: emailSchema, password: newPasswordSchema })
/** "Send me a code" and "Forgot password". */
export const emailFormSchema = z.object({ email: emailSchema })
export const codeFormSchema = z.object({ code: codeSchema })
/** Reset screen: code + new password (once the code is verified, its field is kept but ignored). */
export const resetPasswordSchema = codeAndNewPasswordSchema
/** Account → change password (after the code was sent). */
export const changePasswordSchema = codeAndNewPasswordSchema
export const changeEmailSchema = z.object({ newEmail: emailSchema })
export const emailCodesSchema = z.object({ currentCode: codeSchema, newCode: codeSchema })
/** Account → profile: the name co-members see (the API applies the same limits). */
export const profileFormSchema = z.object({
  displayName: z.string().check(
    z.trim(),
    z.minLength(1, { error: 'account.profile.displayNameRequired' }),
    z.maxLength(PROFILE_DISPLAY_NAME_MAX_LENGTH, {
      error: 'account.profile.displayNameTooLong',
    }),
  ),
})

export type SignInForm = z.input<typeof signInSchema>
export type SignUpForm = z.input<typeof signUpSchema>
export type EmailForm = z.input<typeof emailFormSchema>
export type CodeForm = z.input<typeof codeFormSchema>
export type ResetPasswordForm = z.input<typeof resetPasswordSchema>
export type ChangePasswordForm = z.input<typeof changePasswordSchema>
export type ChangeEmailForm = z.input<typeof changeEmailSchema>
export type EmailCodesForm = z.input<typeof emailCodesSchema>
export type ProfileForm = z.input<typeof profileFormSchema>

/** Interpolation values of form messages that name a limit. */
const MESSAGE_VALUES: Partial<Record<I18nKey, Record<string, number>>> = {
  'auth.validation.passwordTooShort': { count: AUTH_PASSWORD_MIN_LENGTH },
  'auth.verify.codeHint': { count: AUTH_OTP_LENGTH },
  'account.profile.displayNameTooLong': { count: PROFILE_DISPLAY_NAME_MAX_LENGTH },
}

export interface FormMessage {
  key: I18nKey
  values?: Record<string, number>
}

/**
 * A field error message (an i18n key from these schemas, or a flow's FlowError key) as the key and
 * values to pass to `t`. Anything that is not a known key becomes `errors.validation`.
 */
export function formMessage(message: string | null | undefined): FormMessage | undefined {
  if (!message) return undefined
  const key = (hasMessage('en', message) ? message : 'errors.validation') as I18nKey
  const values = MESSAGE_VALUES[key]
  return values ? { key, values } : { key }
}
