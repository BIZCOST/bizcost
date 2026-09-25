import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApiConfig } from '../deps'
import { AppError } from '../errors'
import { adminClient } from './client'

// Supabase Storage with the secret key (docs/ARCHITECTURE.md §Storage): the private bucket
// `business-files` (created by the settings_security migration). Clients never get Storage rights of
// their own; they upload and download only through the signed URLs issued here after the API's
// permission checks.

export const BUSINESS_FILES_BUCKET = 'business-files'

const PURPOSE = 'business files (Storage signed URLs)'

function bucket(config: ApiConfig) {
  return (adminClient(config, PURPOSE) as SupabaseClient).storage.from(BUSINESS_FILES_BUCKET)
}

function storageFailed(what: string, error: unknown): AppError {
  return new AppError('internal', { message: `storage: ${what} failed`, cause: error })
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = 'status' in error ? error.status : undefined
  const statusCode = 'statusCode' in error ? error.statusCode : undefined
  return status === 404 || statusCode === '404' || statusCode === 404
}

/** A signed URL (and its token) to upload one new object at `path`; it never overwrites. */
export async function createSignedUpload(
  config: ApiConfig,
  path: string,
): Promise<{ signedUrl: string; token: string }> {
  const { data, error } = await bucket(config).createSignedUploadUrl(path, { upsert: false })
  if (error || !data) throw storageFailed('signed upload URL', error)
  return { signedUrl: data.signedUrl, token: data.token }
}

/** The object's bytes and stored content type; null when there is no such object. */
export async function downloadObject(
  config: ApiConfig,
  path: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const { data, error } = await bucket(config).download(path)
  if (error) {
    if (isNotFound(error)) return null
    // Storage answers a missing object with 400 in some versions.
    if (error && typeof error === 'object' && 'status' in error && error.status === 400) return null
    throw storageFailed('download', error)
  }
  return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type }
}

/** A signed download URL valid for `ttlSeconds`; null when the object is missing. */
export async function signedDownloadUrl(
  config: ApiConfig,
  path: string,
  ttlSeconds: number,
): Promise<string | null> {
  const { data, error } = await bucket(config).createSignedUrl(path, ttlSeconds)
  if (error) {
    if (isNotFound(error)) return null
    if (error && typeof error === 'object' && 'status' in error && error.status === 400) return null
    throw storageFailed('signed download URL', error)
  }
  return data.signedUrl
}

/** Removes objects; a missing one is not an error. */
export async function removeObjects(config: ApiConfig, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const { error } = await bucket(config).remove([...paths])
  if (error && !isNotFound(error)) throw storageFailed('remove', error)
}
