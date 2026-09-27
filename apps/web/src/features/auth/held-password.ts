import { normalizeEmail } from '@bizcost/app-core'

// The password typed on the sign-up page (or on sign-in, for an email not confirmed yet), held for the
// code page in this page's memory only: never in storage or a URL. The code that confirms the address
// drops any password chosen before it (D-102), so the code page sets this one again with the code's
// session. A reload forgets it; the code page then asks for a password.

let held: { email: string; password: string } | null = null

export function holdPassword(email: string, password: string): void {
  held = { email: normalizeEmail(email), password }
}

/** The password held for `email`, if this page still has it. */
export function heldPassword(email: string): string | null {
  return held && held.email === normalizeEmail(email) ? held.password : null
}

export function forgetPassword(): void {
  held = null
}
