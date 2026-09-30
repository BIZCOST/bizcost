import { defineConfig, devices } from '@playwright/test'
import { baseURL, port, repoRoot, stack } from './stack'

// End-to-end tests of the web app against a production build (`next build` + `next start`) and the
// local Supabase stack (Auth + Mailpit): `pnpm e2e` (docs/ARCHITECTURE.md §Testing & CI). The build
// goes to its own folder (apps/web/.next/e2e) on E2E_PORT (default 3100), so it runs next to a
// developer's `next dev`. One worker: the local Auth server limits sign-ins per IP, and every test
// reads its codes from the shared Mailpit.
//
// Every spec runs on the production build: the Costing Core (Products & Services, Materials,
// Suppliers, Purchases, Expenses, Running Costs, Files and the Cost Engine) is released since M2
// Step 7 (D-188), so the development server with the dev-only preview that its specs used while it
// was built (D-125, D-127) is gone. A module built next brings it back the same way: a `preview`
// project on a `next dev` server with BIZCOST_PREVIEW_MODULES naming it.

const { apiUrl, publishableKey, secretKey } = stack()
const web = 'pnpm --filter @bizcost/web exec next'

/** The web app's environment on the local stack, for a server at `origin`. */
function webEnv(origin: string): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: secretKey,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://bizcost_api:bizcost_local_dev@127.0.0.1:54322/postgres',
    APP_ORIGINS: origin,
    APP_URL: origin,
    // Invitation emails go to the stack's Mailpit (SMTP 127.0.0.1:54325).
    EMAIL_TRANSPORT: 'smtp',
    NEXT_TELEMETRY_DISABLED: '1',
  }
}

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
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
  webServer: [
    {
      command: `${web} build && ${web} start --port ${port}`,
      cwd: repoRoot,
      url: `${baseURL}/login`,
      // Never reuse a server already on the port: it may serve an old build (pick another E2E_PORT).
      reuseExistingServer: false,
      timeout: 300_000,
      env: { NEXT_DIST_DIR: '.next/e2e', ...webEnv(baseURL) },
    },
  ],
})
