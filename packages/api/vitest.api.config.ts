import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import unitConfig from './vitest.config.ts'

// Integration tests against the local Supabase stack (Postgres + Auth), through the real fetch handler.
// Needs `supabase start` and the local signing key (docs/ARCHITECTURE.md §Testing & CI). Local keys
// only: they are read from `supabase status` when not in the environment, and never printed.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function localStackEnv(): Record<string, string> {
  const wanted = ['API_URL', 'PUBLISHABLE_KEY', 'SECRET_KEY', 'JWT_SECRET']
  if (wanted.every((name) => process.env[`SUPABASE_${name}`])) return {}
  // stdout (the keys) is parsed, never printed; stderr carries the CLI's reason on failure. The
  // execSync error is not rethrown as a cause because it also holds stdout.
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
        'Is the local stack running (`pnpm exec supabase start`), is Docker on PATH, and does ' +
        'supabase/signing_keys.json exist (`pnpm auth:signing-key`)?',
    )
  }
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line.trim())
    if (match?.[1] && match[2] !== undefined && wanted.includes(match[1])) {
      values[`SUPABASE_${match[1]}`] = match[2]
    }
  }
  return values
}

const config = mergeConfig(
  unitConfig,
  defineConfig({
    test: {
      env: {
        ...localStackEnv(),
        DATABASE_URL_ADMIN:
          process.env.DATABASE_URL_ADMIN ??
          'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://bizcost_api:bizcost_local_dev@127.0.0.1:54322/postgres',
        SIGNING_KEYS_PATH: fileURLToPath(
          new URL('../../supabase/signing_keys.json', import.meta.url),
        ),
      },
      fileParallelism: false,
      testTimeout: 20_000,
      hookTimeout: 60_000,
    },
  }),
)
// mergeConfig concatenates arrays: replace the unit-test pattern instead of adding to it.
config.test.include = ['test/**/*.api.test.ts']

export default config
