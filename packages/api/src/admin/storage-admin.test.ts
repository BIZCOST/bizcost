import { LOGO_URL_TTL_SECONDS, MEMBERSHIP_LOGOS_MAX } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiConfig } from '../deps'
import { LOGO_SIGNING_PAUSE_MS, membershipLogoUrls } from '../services/business-profile'
import { signedDownloadUrl, signedDownloadUrls } from './storage-admin'

// Signed logo URLs (D-097) against a fake Storage: one request for many paths, the same URL again
// while at least half its time is left, at most MEMBERSHIP_LOGOS_MAX logos of the business's own
// folder for `me`, and after a failure no logos (one report) without asking Storage for a while.

const storage = vi.hoisted(() => ({
  single: [] as string[],
  batches: [] as string[][],
  missing: new Set<string>(),
  serial: 0,
  down: false,
}))

vi.mock('./client', () => {
  const sign = (path: string) =>
    `https://db.test/storage/v1/object/sign/business-files/${path}?token=${++storage.serial}`
  const bucket = {
    createSignedUrl: (path: string) => {
      storage.single.push(path)
      return Promise.resolve({ data: { signedUrl: sign(path) }, error: null })
    },
    createSignedUrls: (paths: string[]) => {
      storage.batches.push(paths)
      if (storage.down) {
        return Promise.resolve({ data: null, error: new Error('fetch failed: TimeoutError') })
      }
      return Promise.resolve({
        data: paths.map((path) =>
          storage.missing.has(path)
            ? { path, error: 'Either the object does not exist', signedUrl: null, signedURL: null }
            : { path, error: null, signedUrl: sign(path), signedURL: null },
        ),
        error: null,
      })
    },
  }
  return { adminClient: () => ({ storage: { from: () => bucket } }) }
})

const TTL_MS = LOGO_URL_TTL_SECONDS * 1000
let config: ApiConfig

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-27T10:00:00Z') })
  storage.single.length = 0
  storage.batches.length = 0
  storage.missing.clear()
  storage.down = false
  // Each test has its own cache (it lives per config).
  config = { supabaseUrl: 'https://db.test' } as ApiConfig
})

afterEach(() => {
  vi.useRealTimers()
})

const logoPath = (businessId: string) => `${businessId}/logo/${newId()}.png`

const notReported = (error: unknown) => {
  throw new Error(`unexpected report: ${String(error)}`)
}

function ownLogo() {
  const businessId = newId()
  return { businessId, logoPath: logoPath(businessId) }
}

describe('signed download URLs', () => {
  it('signs many paths in one request and leaves out missing objects', async () => {
    const [a, b, gone] = [logoPath(newId()), logoPath(newId()), logoPath(newId())]
    storage.missing.add(gone)
    const urls = await signedDownloadUrls(config, [a, b, gone, a], LOGO_URL_TTL_SECONDS)
    expect(storage.batches).toEqual([[a, b, gone]])
    expect([...urls.keys()]).toEqual([a, b])
  })

  it('hands out the same URL while at least half of its time is left, then a new one', async () => {
    const path = logoPath(newId())
    const first = await signedDownloadUrl(config, path, LOGO_URL_TTL_SECONDS)
    vi.advanceTimersByTime(TTL_MS / 2 - 1000)
    expect(await signedDownloadUrl(config, path, LOGO_URL_TTL_SECONDS)).toBe(first)
    expect((await signedDownloadUrls(config, [path], LOGO_URL_TTL_SECONDS)).get(path)).toBe(first)
    expect(storage.single).toHaveLength(1)
    expect(storage.batches).toEqual([])

    vi.advanceTimersByTime(2000)
    const renewed = (await signedDownloadUrls(config, [path], LOGO_URL_TTL_SECONDS)).get(path)
    expect(renewed).toBeDefined()
    expect(renewed).not.toBe(first)
    expect(storage.batches).toEqual([[path]])
  })

  it('keeps URLs apart per configuration and per lifetime', async () => {
    const path = logoPath(newId())
    const first = await signedDownloadUrl(config, path, LOGO_URL_TTL_SECONDS)
    const other = { supabaseUrl: 'https://db.test' } as ApiConfig
    expect(await signedDownloadUrl(other, path, LOGO_URL_TTL_SECONDS)).not.toBe(first)
    expect(await signedDownloadUrl(config, path, 60)).not.toBe(first)
  })
})

describe('membershipLogoUrls', () => {
  it('signs at most MEMBERSHIP_LOGOS_MAX logos, in the order given, in one request', async () => {
    const logos = Array.from({ length: MEMBERSHIP_LOGOS_MAX + 5 }, ownLogo)
    const urls = await membershipLogoUrls(config, logos, notReported)
    expect(storage.batches).toHaveLength(1)
    expect(storage.batches[0]).toEqual(logos.slice(0, MEMBERSHIP_LOGOS_MAX).map((l) => l.logoPath))
    expect(urls.size).toBe(MEMBERSHIP_LOGOS_MAX)
    const first = logos[0]!
    expect(urls.get(first.businessId)).toContain(`/business-files/${first.logoPath}?`)
  })

  it('signs only a path in the business’s own logo folder', async () => {
    const [mine, theirs] = [newId(), newId()]
    const urls = await membershipLogoUrls(
      config,
      [
        { businessId: mine, logoPath: logoPath(theirs) },
        { businessId: mine, logoPath: `${mine}/logo/../../${theirs}/logo/x.png` },
        { businessId: mine, logoPath: `${mine}/invoices/${newId()}.png` },
      ],
      notReported,
    )
    expect(urls.size).toBe(0)
    expect(storage.batches).toEqual([])
  })

  it('asks Storage nothing without logos', async () => {
    expect((await membershipLogoUrls(config, [], notReported)).size).toBe(0)
    expect(storage.batches).toEqual([])
  })

  it('after Storage fails: no logos, one report, and Storage is not asked again for a while', async () => {
    const logos = [ownLogo(), ownLogo()]
    const reported: unknown[] = []
    const report = (error: unknown) => reported.push(error)
    storage.down = true
    expect((await membershipLogoUrls(config, logos, report)).size).toBe(0)
    expect(reported).toHaveLength(1)
    expect(storage.batches).toHaveLength(1)

    // Paused: every `me` meanwhile answers at once, without a Storage request or a report.
    storage.down = false
    vi.advanceTimersByTime(LOGO_SIGNING_PAUSE_MS - 1000)
    expect((await membershipLogoUrls(config, logos, report)).size).toBe(0)
    expect(storage.batches).toHaveLength(1)
    expect(reported).toHaveLength(1)

    // Then Storage is asked again.
    vi.advanceTimersByTime(2000)
    expect((await membershipLogoUrls(config, logos, report)).size).toBe(2)
    expect(storage.batches).toHaveLength(2)
    expect(reported).toHaveLength(1)
  })
})
