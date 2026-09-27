import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

// The local Supabase stack the demo data goes to (docs/ARCHITECTURE.md §Local setup › Demo data).
// Everything is read from `supabase status` (never from the environment, which may name another
// database), and the demo refuses to run unless that is the CLI's local stack: loopback addresses,
// and the database carries the public demo JWT secret that only the local stack sets (the same guard
// as supabase/seed.sql). Keys are local-only values and are never printed.

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const signingKeysPath = fileURLToPath(
  new URL('../../../supabase/signing_keys.json', import.meta.url),
)

/** The local stack's public JWT secret (supabase/seed.sql checks the same database setting). */
const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** The local API role's password, set by supabase/seed.sql on the local stack only. */
const LOCAL_API_ROLE = { user: 'bizcost_api', password: 'bizcost_local_dev' }

/** Mailpit's SMTP port (supabase/config.toml [local_smtp] smtp_port). */
export const LOCAL_SMTP_PORT = 54325

export interface LocalStack {
  apiUrl: string
  mailpitUrl: string
  smtpHost: string
}

function status(): Record<string, string> {
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
        'Start the local stack first (`pnpm exec supabase start`, Docker on PATH).',
    )
  }
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line.trim())
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2]
  }
  return values
}

function requireLoopback(name: string, value: string | undefined): URL {
  if (!value) throw new Error(`\`supabase status\` did not list ${name}`)
  const url = new URL(value)
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(`${name} is not on this machine (${url.hostname}): demo data is local only`)
  }
  return url
}

/**
 * Checks that this is the local stack, then sets the variables the API test helpers read
 * (test/helpers.ts), overriding anything in the environment.
 */
export async function useLocalStack(): Promise<LocalStack> {
  const values = status()
  const api = requireLoopback('API_URL', values.API_URL)
  const db = requireLoopback('DB_URL', values.DB_URL)
  const mailpit = requireLoopback('MAILPIT_URL', values.MAILPIT_URL ?? values.INBUCKET_URL)
  for (const name of ['PUBLISHABLE_KEY', 'SECRET_KEY', 'JWT_SECRET']) {
    if (!values[name]) throw new Error(`\`supabase status\` did not list ${name}`)
  }
  if (!existsSync(signingKeysPath)) {
    throw new Error('supabase/signing_keys.json is missing (`pnpm auth:signing-key`)')
  }

  const sql = postgres(db.href, { max: 1, onnotice: () => {} })
  try {
    const [row] = await sql<{ local: boolean }[]>`
      select coalesce(current_setting('app.settings.jwt_secret', true), '') = ${LOCAL_JWT_SECRET} as local`
    if (!row?.local)
      throw new Error('this database is not the local Supabase stack; refusing to run')
  } finally {
    await sql.end()
  }

  const apiRole = new URL(db.href)
  apiRole.username = LOCAL_API_ROLE.user
  apiRole.password = LOCAL_API_ROLE.password
  Object.assign(process.env, {
    SUPABASE_API_URL: api.origin,
    SUPABASE_PUBLISHABLE_KEY: values.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: values.SECRET_KEY,
    SUPABASE_JWT_SECRET: values.JWT_SECRET,
    DATABASE_URL: apiRole.href,
    DATABASE_URL_ADMIN: db.href,
    SIGNING_KEYS_PATH: signingKeysPath,
  })
  return { apiUrl: api.origin, mailpitUrl: mailpit.origin, smtpHost: api.hostname }
}
