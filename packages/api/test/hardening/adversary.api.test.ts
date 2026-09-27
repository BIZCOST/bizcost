import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ADVERSARY (Step 9 review): gaps in the hardening suites themselves, kept as regression tests.
//   - CI must run every service the suites attack (below).
//   - A query that writes business rows: `me`'s email copy is now exercised and pinned down in
//     audit-coverage.api.test.ts ("the documented exceptions", D-103).

const CI_WORKFLOW = fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url))

/** The services the CI `db` job leaves out of `supabase start` (its `-x` list). */
function ciExcludedServices(): string[] {
  const text = readFileSync(CI_WORKFLOW, 'utf8')
  const match = /supabase start\s+-x\s+([a-z0-9,-]+)/.exec(text)
  if (!match?.[1]) throw new Error('no `supabase start -x …` in ci.yml')
  return match[1].split(',')
}

describe('CI runs every service the hardening suites attack', () => {
  it('PostgREST runs in the CI stack (direct-access.api.test.ts attacks /rest/v1)', () => {
    // hardening/direct-access.api.test.ts expects PostgREST's own answers: 200 and an OpenAPI root
    // for a real token, 406 for `accept-profile: app`, 401 for a broken signature. Without PostgREST
    // in the CI stack, /rest/v1 has nothing behind the gateway: that suite would fail there, and
    // loosening it to "any refusal" would make the Data API attack vacuous in CI while hosted
    // projects do run PostgREST.
    expect(ciExcludedServices()).not.toContain('postgrest')
  })
})
