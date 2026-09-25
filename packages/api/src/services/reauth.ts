import { AUTH_RECENT_SIGN_IN_SECONDS } from '@bizcost/contracts'
import type { AuthUser } from '../auth'
import { AppError } from '../errors'

/**
 * Actions that cannot be undone need a recent proof of identity (D-063, D-064): a password sign-in or
 * an emailed code entered within AUTH_RECENT_SIGN_IN_SECONDS (the newest `amr` entry of the access
 * token). Otherwise `reauth_required`: the web asks for an emailed code ("confirm it's you") and
 * retries. Used by account deletion and ownership transfer.
 */
export function assertRecentSignIn(auth: AuthUser, now: number = Math.floor(Date.now() / 1000)) {
  if (auth.authenticatedAt === null || now - auth.authenticatedAt > AUTH_RECENT_SIGN_IN_SECONDS) {
    throw new AppError('reauth_required')
  }
}
