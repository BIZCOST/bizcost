import {
  AUTH_OTP_LENGTH,
  AUTH_PASSWORD_MAX_BYTES,
  AUTH_PASSWORD_MIN_LENGTH,
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
  withoutControlCharacters,
} from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
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

/**
 * The password typed to sign in: only required (the server checks it). Passwords chosen under an
 * older rule still sign in, so the new-password rules do not apply here.
 */
export const passwordSchema = z
  .string()
  .check(z.minLength(1, { error: 'auth.validation.passwordRequired' }))

// Supabase's `letters_digits` (D-072): ASCII only. Arabic letters and Arabic-Indic digits do not
// count, and a password is never normalized (it must reach the server exactly as typed).
const ASCII_LETTER = /[A-Za-z]/
const ASCII_DIGIT = /[0-9]/

export interface PasswordChecks {
  /** At least AUTH_PASSWORD_MIN_LENGTH characters (code points: an emoji counts once). */
  length: boolean
  /** An ASCII letter (a-z or A-Z). */
  letter: boolean
  /** An ASCII digit (0-9). */
  digit: boolean
}

/**
 * Which new-password rules `password` meets: the live checklist under the field, and the schema
 * below, so the two never disagree. The Auth server counts `minimum_password_length` in UTF-8 bytes,
 * so for Arabic letters or emoji this 8-character check is the stricter one (D-072).
 */
export function passwordChecks(password: string): PasswordChecks {
  return {
    length: [...password].length >= AUTH_PASSWORD_MIN_LENGTH,
    letter: ASCII_LETTER.test(password),
    digit: ASCII_DIGIT.test(password),
  }
}

/**
 * A new password: the rule the Auth server enforces (`[auth] minimum_password_length` and
 * `password_requirements`) and bcrypt's 72-byte limit.
 */
export const newPasswordSchema = z.string().check(
  z.refine((value: string) => passwordChecks(value).length, {
    error: 'auth.validation.passwordTooShort',
  }),
  z.refine((value: string) => utf8.encode(value).length <= AUTH_PASSWORD_MAX_BYTES, {
    error: 'auth.validation.passwordTooLong',
  }),
  z.refine(
    (value: string) => {
      const checks = passwordChecks(value)
      return checks.letter && checks.digit
    },
    { error: 'auth.validation.passwordNeedsMix' },
  ),
)

/** An email code: Arabic-Indic digits and pasted text are normalized first. */
export const codeSchema = z.pipe(
  z.pipe(z.string(), z.transform(normalizeCode)),
  z.string().check(z.length(AUTH_OTP_LENGTH, { error: 'auth.validation.codeIncomplete' })),
)

/** The new password typed twice must match. */
const samePasswordTwice = () =>
  z.refine<{ password: string; confirmPassword: string }>(
    (value) => value.password === value.confirmPassword,
    { error: 'auth.validation.passwordsDontMatch', path: ['confirmPassword'] },
  )

export const signInSchema = z.object({ email: emailSchema, password: passwordSchema })
export const signUpSchema = z.object({ email: emailSchema, password: newPasswordSchema })
/** "Send me a code" and "Forgot password". */
export const emailFormSchema = z.object({ email: emailSchema })
export const codeFormSchema = z.object({ code: codeSchema })
/** Reset screen, after the code was accepted and the user chose to change it: a new password twice. */
export const resetPasswordSchema = z
  .object({ password: newPasswordSchema, confirmPassword: z.string() })
  .check(samePasswordTwice())
/** Account → change password (after the code was sent): the code and a new password twice. */
export const changePasswordSchema = z
  .object({ code: codeSchema, password: newPasswordSchema, confirmPassword: z.string() })
  .check(samePasswordTwice())
export const changeEmailSchema = z.object({ newEmail: emailSchema })
export const emailCodesSchema = z.object({ currentCode: codeSchema, newCode: codeSchema })
/** Account → profile: the name co-members see (the API applies the same limits). */
export const profileFormSchema = z.object({
  displayName: z.string().check(
    // A pasted tab or line break becomes a space (the API refuses control characters).
    z.overwrite(withoutControlCharacters),
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
 * values to pass to `t`. Anything that is not a known key becomes `errors.validation`. `has` says
 * whether a key has a message, e.g. `(k) => hasKey(i18n, k)` with the page's i18n instance (the
 * browser holds only the page's messages, so this package never imports them).
 */
export function formMessage(
  message: string | null | undefined,
  has: (key: string) => boolean,
): FormMessage | undefined {
  if (!message) return undefined
  const key = (has(message) ? message : 'errors.validation') as I18nKey
  const values = MESSAGE_VALUES[key]
  return values ? { key, values } : { key }
}
