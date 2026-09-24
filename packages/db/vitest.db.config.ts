import { defineConfig, mergeConfig } from 'vitest/config'
import unitConfig from './vitest.config.ts'

// Integration tests against the local Supabase database (run `pnpm db:reset` first).
// DATABASE_URL_ADMIN: `postgres`, used only for test setup and assertions (auth.users rows, lookups).
// DATABASE_URL: the API role bizcost_api (password from supabase/seed.sql, local only).
const config = mergeConfig(
  unitConfig,
  defineConfig({
    test: {
      env: {
        DATABASE_URL_ADMIN:
          process.env.DATABASE_URL_ADMIN ??
          'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://bizcost_api:bizcost_local_dev@127.0.0.1:54322/postgres',
      },
      fileParallelism: false,
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  }),
)
// mergeConfig concatenates arrays: replace the unit-test pattern instead of adding to it.
config.test.include = ['test/**/*.db.test.ts']

export default config
