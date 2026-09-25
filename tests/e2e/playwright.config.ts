import { defineConfig, devices } from '@playwright/test'
import { baseURL, port, repoRoot, stack } from './stack'

// End-to-end tests of the web app against a production build (`next build` + `next start`) and the
// local Supabase stack (Auth + Mailpit): `pnpm e2e` (docs/ARCHITECTURE.md §Testing & CI). The build
// goes to its own folder (apps/web/.next/e2e) on E2E_PORT (default 3100), so it runs next to a
// developer's `next dev`. One worker: the local Auth server limits sign-ins per IP, and every test
// reads its codes from the shared Mailpit.

const { apiUrl, publishableKey, secretKey } = stack()
const web = 'pnpm --filter @bizcost/web exec next'

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './test-results',
  use: {
    baseURL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `${web} build && ${web} start --port ${port}`,
    cwd: repoRoot,
    url: `${baseURL}/login`,
    // Never reuse a server already on the port: it may serve an old build (pick another E2E_PORT).
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      NEXT_DIST_DIR: '.next/e2e',
      NEXT_PUBLIC_SUPABASE_URL: apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_SECRET_KEY: secretKey,
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://bizcost_api:bizcost_local_dev@127.0.0.1:54322/postgres',
      APP_ORIGINS: baseURL,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
})
