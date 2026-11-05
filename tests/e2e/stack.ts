import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// The local Supabase stack the e2e tests run against (docs/ARCHITECTURE.md §Local setup). Keys are
// local-only values read from `supabase status`; they are never printed.

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/** The web app under test (a production build started by Playwright on E2E_PORT, default 3100). */
export const port = Number(process.env.E2E_PORT ?? 3100)
export const baseURL = `http://localhost:${port}`

/**
 * A development server (`next dev`) with the dev-only preview of the modules being built (D-125,
 * D-127), on E2E_PREVIEW_PORT (default: the port after E2E_PORT). Only the specs of those modules run
 * on it: a production build never shows a module before its release, whatever its environment says.
 * M4 Step 2: Stock (`inventory`, released with Release A of M4, Step 5).
 */
export const previewPort = Number(process.env.E2E_PREVIEW_PORT ?? port + 1)
export const previewBaseURL = `http://localhost:${previewPort}`
export const PREVIEW_MODULES = 'inventory'

/**
 * The same production build on a second port, with a module held back as hosted deployments hold it
 * (BIZCOST_HELD_MODULES, D-359), on E2E_HELD_PORT (default E2E_PORT + 2). beta.spec.ts runs on it.
 */
export const heldPort = Number(process.env.E2E_HELD_PORT ?? port + 2)
export const heldBaseURL = `http://localhost:${heldPort}`
export const HELD_MODULES = 'invoices'

/**
 * The owner's beta page and where feedback goes (D-356, D-357): one address per run, so a run never
 * meets what an earlier one left. The workers inherit them from the runner that starts the servers.
 */
const run = (process.env.E2E_RUN_ID ??= randomUUID()
  .replace(/-/g, '')
  .slice(0, 10)
  .replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit))))
export const E2E_PLATFORM_ADMIN = `e2e-platform-${run}@test.bizcost.local`
export const E2E_FEEDBACK_TO = `e2e-feedback-${run}@test.bizcost.local`

export interface Stack {
  apiUrl: string
  publishableKey: string
  secretKey: string
  mailpitUrl: string
}

let cached: Stack | undefined

export function stack(): Stack {
  if (cached) return cached
  const fromEnv = {
    apiUrl: process.env.SUPABASE_API_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    secretKey: process.env.SUPABASE_SECRET_KEY,
    mailpitUrl: process.env.SUPABASE_MAILPIT_URL,
  }
  if (Object.values(fromEnv).every(Boolean)) return (cached = fromEnv as Stack)
  // stdout (the keys) is parsed, never printed; the execSync error is not rethrown as a cause
  // because it holds stdout too.
  let output: string | undefined
  let reason = ''
  try {
    output = execSync('pnpm exec supabase status -o env', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    reason = String((error as { stderr?: unknown }).stderr ?? '').trim()
  }
  if (output === undefined) {
    throw new Error(
      `\`supabase status\` failed${reason ? `: ${reason}` : ''}\n` +
        'The e2e tests need the local stack (`pnpm exec supabase start`) with Docker on PATH.',
    )
  }
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line.trim())
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2]
  }
  const mailpitUrl = values.MAILPIT_URL ?? values.INBUCKET_URL
  if (!values.API_URL || !values.PUBLISHABLE_KEY || !values.SECRET_KEY || !mailpitUrl) {
    throw new Error(
      '`supabase status` did not list API_URL, PUBLISHABLE_KEY, SECRET_KEY and MAILPIT_URL',
    )
  }
  cached = {
    apiUrl: values.API_URL,
    publishableKey: values.PUBLISHABLE_KEY,
    secretKey: values.SECRET_KEY,
    mailpitUrl,
  }
  return cached
}
