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

/**
 * Signing download URLs gives up after this long (D-097): `me` waits for the logos' URLs on every
 * signed-in page, so a slow or unreachable Storage must not hold the app. Uploads and downloads of
 * objects are not bounded.
 */
export const SIGNING_TIMEOUT_MS = 2000

function bucket(config: ApiConfig, timeoutMs?: number) {
  return (adminClient(config, PURPOSE, timeoutMs) as SupabaseClient).storage.from(
    BUSINESS_FILES_BUCKET,
  )
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

// Signed download URLs are handed out again while at least half of their time is left (D-097): the
// same logo keeps the same URL across requests and users (each holder is a member the API checked),
// and Storage serves a signed URL with an Expires header at the URL's own expiry, so browsers keep the
// image cached instead of downloading it again with each `me`; Storage signs a path at most about
// twice per TTL per server instance. A URL is never handed out beyond the expiry Storage gave it.
// Bounded; the oldest entries go first.
const ISSUED_MAX = 1000
const issued = new WeakMap<ApiConfig, Map<string, { url: string; expiresAt: number }>>()

function issuedFor(config: ApiConfig) {
  let cache = issued.get(config)
  if (!cache) {
    cache = new Map()
    issued.set(config, cache)
  }
  return cache
}

const issuedKey = (path: string, ttlSeconds: number) => `${ttlSeconds}:${path}`

function reuseIssued(config: ApiConfig, path: string, ttlSeconds: number): string | null {
  const cache = issuedFor(config)
  const key = issuedKey(path, ttlSeconds)
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expiresAt - Date.now() >= (ttlSeconds * 1000) / 2) return hit.url
  cache.delete(key)
  return null
}

/** `requestedAt`: before the signing request, so the expiry noted is never later than Storage's. */
function rememberIssued(
  config: ApiConfig,
  path: string,
  ttlSeconds: number,
  url: string,
  requestedAt: number,
) {
  const cache = issuedFor(config)
  const key = issuedKey(path, ttlSeconds)
  cache.delete(key)
  cache.set(key, { url, expiresAt: requestedAt + ttlSeconds * 1000 })
  for (const oldest of cache.keys()) {
    if (cache.size <= ISSUED_MAX) break
    cache.delete(oldest)
  }
}

/**
 * A signed download URL valid for at least half of `ttlSeconds`; null when the object is missing.
 * Fails after SIGNING_TIMEOUT_MS.
 */
export async function signedDownloadUrl(
  config: ApiConfig,
  path: string,
  ttlSeconds: number,
): Promise<string | null> {
  const reused = reuseIssued(config, path, ttlSeconds)
  if (reused) return reused
  const requestedAt = Date.now()
  const { data, error } = await bucket(config, SIGNING_TIMEOUT_MS).createSignedUrl(path, ttlSeconds)
  if (error) {
    if (isNotFound(error)) return null
    if (error && typeof error === 'object' && 'status' in error && error.status === 400) return null
    throw storageFailed('signed download URL', error)
  }
  rememberIssued(config, path, ttlSeconds, data.signedUrl, requestedAt)
  return data.signedUrl
}

/**
 * Signed download URLs for several objects, in one Storage request for those not issued recently
 * (valid for at least half of `ttlSeconds`). A missing object has no entry. Fails after
 * SIGNING_TIMEOUT_MS.
 */
export async function signedDownloadUrls(
  config: ApiConfig,
  paths: readonly string[],
  ttlSeconds: number,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  const missing: string[] = []
  for (const path of new Set(paths)) {
    const reused = reuseIssued(config, path, ttlSeconds)
    if (reused) urls.set(path, reused)
    else missing.push(path)
  }
  if (missing.length === 0) return urls
  const requestedAt = Date.now()
  const { data, error } = await bucket(config, SIGNING_TIMEOUT_MS).createSignedUrls(
    missing,
    ttlSeconds,
  )
  if (error) throw storageFailed('signed download URLs', error)
  for (const item of data) {
    // A missing object comes back with an error and no URL.
    if (item.error || !item.path || !item.signedUrl || !missing.includes(item.path)) continue
    rememberIssued(config, item.path, ttlSeconds, item.signedUrl, requestedAt)
    urls.set(item.path, item.signedUrl)
  }
  return urls
}

/** Removes objects; a missing one is not an error. */
export async function removeObjects(config: ApiConfig, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const { error } = await bucket(config).remove([...paths])
  if (error && !isNotFound(error)) throw storageFailed('remove', error)
}
