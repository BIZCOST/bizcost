import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApiConfig } from '../deps'
import { AppError } from '../errors'
import { adminClient as secretKeyClient, assertSecretKey } from './client'

// The Supabase Auth admin API with the secret key (docs/ARCHITECTURE.md §Secrets & server-only code).
// Lint allows only the account service (and the business profile service, for Storage) to import src/admin.

const PURPOSE = 'deleting an account'

/** Fails before any change when the secret key is not configured (e.g. a local .env without it). */
export function assertAuthAdmin(config: ApiConfig): string {
  return assertSecretKey(config, PURPOSE)
}

function adminClient(config: ApiConfig): SupabaseClient {
  return secretKeyClient(config, PURPOSE)
}

function isNotFound(error: { code?: string; status?: number }): boolean {
  return error.code === 'user_not_found' || error.status === 404
}

/**
 * Whether the auth user still exists. Called before account deletion changes anything, so a wrong or
 * rotated secret key, or an unreachable Auth server, fails the deletion (`internal`) while nothing has
 * changed yet.
 */
export async function authUserExists(config: ApiConfig, userId: string): Promise<boolean> {
  const { data, error } = await adminClient(config).auth.admin.getUserById(userId)
  if (error) {
    if (isNotFound(error)) return false
    throw new AppError('internal', { message: 'the Auth admin API is not usable', cause: error })
  }
  return data.user?.id === userId
}

/**
 * Deletes the auth user (sessions and refresh tokens go with it). A user that is already gone counts
 * as deleted, so a retried account deletion can finish.
 */
export async function deleteAuthUser(config: ApiConfig, userId: string): Promise<void> {
  const { error } = await adminClient(config).auth.admin.deleteUser(userId)
  if (error && !isNotFound(error)) {
    throw new AppError('internal', { message: 'could not delete the auth user', cause: error })
  }
}
