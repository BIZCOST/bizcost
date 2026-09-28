import { defineConfig, devices } from '@playwright/test'
import {
  baseURL,
  PREVIEW_MODULES,
  port,
  previewBaseURL,
  previewPort,
  repoRoot,
  stack,
} from './stack'

// End-to-end tests of the web app against a production build (`next build` + `next start`) and the
// local Supabase stack (Auth + Mailpit): `pnpm e2e` (docs/ARCHITECTURE.md §Testing & CI). The build
// goes to its own folder (apps/web/.next/e2e) on E2E_PORT (default 3100), so it runs next to a
// developer's `next dev`. One worker: the local Auth server limits sign-ins per IP, and every test
// reads its codes from the shared Mailpit.
//
// The modules being built (M2 Step 2: Materials, Products & Services) are still `planned`, and a
// production build never shows a planned module (D-125). Their specs (`preview` project) run on a
// `next dev` server with the dev-only preview, in its own folder (.next/e2e-preview) on
// E2E_PREVIEW_PORT (default E2E_PORT + 1). When Step 7 releases them, their specs move to the
// production project and this server goes.

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

/** Specs of the modules shown only by the dev-only preview. */
const PREVIEW_SPECS = /catalog\.spec\.ts$/

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
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: PREVIEW_SPECS,
    },
    {
      name: 'preview',
      use: { ...devices['Desktop Chrome'], baseURL: previewBaseURL },
      testMatch: PREVIEW_SPECS,
      // A development server compiles each page the first time it is opened.
      timeout: 240_000,
      expect: { timeout: 30_000 },
    },
  ],
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
    {
      command: `${web} dev --port ${previewPort}`,
      cwd: repoRoot,
      url: `${previewBaseURL}/login`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        NEXT_DIST_DIR: '.next/e2e-preview',
        BIZCOST_PREVIEW_MODULES: PREVIEW_MODULES,
        ...webEnv(previewBaseURL),
      },
    },
  ],
})
