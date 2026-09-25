// Auth limits shared by the apps, the auth flows (@bizcost/app-core) and supabase/config.toml
// (docs/ARCHITECTURE.md §Auth). A test in @bizcost/app-core checks them against config.toml.

/** Digits in an email code (`[auth.email] otp_length`). */
export const AUTH_OTP_LENGTH = 6

/** Seconds before another code can be sent to the same address (`[auth.email] max_frequency`). */
export const AUTH_RESEND_COOLDOWN_SECONDS = 60

/** Shortest accepted password (`[auth] minimum_password_length`). */
export const AUTH_PASSWORD_MIN_LENGTH = 10

/** Longest accepted password in UTF-8 bytes: Supabase Auth hashes with bcrypt, which reads 72. */
export const AUTH_PASSWORD_MAX_BYTES = 72

/**
 * Account deletion needs a recent sign-in: the newest authentication in the access token's `amr`
 * claim (a password, or an emailed code the user has just entered) must be at most this old.
 */
export const AUTH_RECENT_SIGN_IN_SECONDS = 600

/**
 * Whether the Supabase session cookies (access and refresh token) get the Secure flag for a page or
 * request at `url`: always, except plain http on a host other than localhost (e.g. a phone trying the
 * dev server over the LAN, whose browser would drop Secure cookies). Browsers treat localhost as a
 * secure context, so local development keeps Secure cookies too.
 */
export function secureSessionCookies(url: string | { readonly href: string }): boolean {
  const href = typeof url === 'string' ? url : url.href
  const match = /^([a-z][a-z\d+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(href)
  const scheme = match?.[1]?.toLowerCase()
  const host = match?.[2]?.toLowerCase()
  return scheme === 'https' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}
