# BizCost Architecture

Purpose: technical system design, repo structure and engineering conventions for BizCost (web + mobile + shared backend).
Last updated: 2026-09-24

**Status:** only the repo scaffold exists (Step 0a done: workspace, tooling, CI, `packages/config`, first `packages/domain` code). Everything below is **DECIDED** design. Items tagged **[Later]** are planned but not part of M1. Product rules are in PRODUCT.md, tables in DATA_MODEL.md, steps and deadlines in ROADMAP.md, and the reasons behind each choice in DECISIONS.md.

## Overview

```
 ┌──────────────────────────────┐        ┌──────────────────────────────┐
 │ Web: Next.js 16 (browser)    │        │ Mobile: Expo SDK 57          │
 │ desktop · tablet · phone     │        │ iOS + Android (EAS builds)   │
 └──────────────┬───────────────┘        └───────────────┬──────────────┘
   same origin, │ cookies (@supabase/ssr)                │ Authorization: Bearer
                │                                        │ x-business-id, x-app-version
                ▼                                        ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │ Vercel Pro, functions pinned to bom1 (Mumbai): one project (apps/web)  │
 │ UI + tRPC v11 at /api/trpc (code in packages/api)                      │
 │ getClaims → middlewares → withTenantTx → Drizzle/postgres.js           │
 └───────────────────────────────┬────────────────────────────────────────┘
                                 │ Supavisor transaction pooler :6543, role bizcost_api
                                 ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │ Supabase ap-south-1 (Mumbai); prod via custom domain auth.<domain>     │
 │ Postgres (schema app, FORCE RLS) · Auth · Storage (private bucket)     │
 └────────────────────────────────────────────────────────────────────────┘
 Clients use supabase-js for Auth only (sign-in, codes, token refresh), via the custom domain.
```

- Three hosted parts: one Vercel project, Supabase, EAS. There is no separate API server and there are no Edge Functions.
- All data goes through tRPC. Files go through signed URLs that the API issues.
- Web and mobile share logic (packages), never UI components (JSX).
- Exit paths: the router uses only fetch Request/Response, so it can move to a standalone Hono service in about a day if Vercel limits bite. Postgres and the SQL migrations are standard.

## Stack

| Area        | Choice                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo    | pnpm 10 (`node-linker=hoisted`, catalogs) + Turborepo 2 · Node 24 LTS · TypeScript 6.0 strict · ESLint 10 flat + typescript-eslint 8 · Prettier 3 |
| React       | 19.2, one version repo-wide (catalog + overrides)                                                                                                 |
| Web         | Next.js 16 App Router (16.3.x; security patches applied fast via Renovate)                                                                        |
| Mobile      | Expo SDK 57 (RN 0.86), expo-router, dev builds (never Expo Go)                                                                                    |
| API         | tRPC v11 + `@trpc/tanstack-react-query` (queryOptions/mutationOptions), no transformer                                                            |
| Client data | TanStack Query v5 · react-hook-form + zodResolver · nuqs (web URL state)                                                                          |
| Validation  | Zod v4 (DTOs + sensitivity metadata)                                                                                                              |
| DB access   | Drizzle ORM 0.45.x (stable line, not 1.0 beta) + postgres.js                                                                                      |
| Backend     | Supabase Postgres, Auth, Storage (ap-south-1) · Vercel Pro (bom1)                                                                                 |
| Web UI      | Tailwind CSS v4 + shadcn/ui (`rtl: true`), Radix, TanStack Table v8, sonner, vaul, lucide-react                                                   |
| Mobile UI   | Uniwind (Tailwind v4, MIT), @gorhom/bottom-sheet, FlashList, lucide-react-native                                                                  |
| i18n        | i18next + react-i18next (both platforms), expo-localization, FormatJS Intl polyfills (mobile)                                                     |
| Numbers     | decimal.js (in `packages/domain`)                                                                                                                 |
| Fonts       | IBM Plex Sans Arabic + IBM Plex Sans                                                                                                              |
| Tests       | Vitest (+ fast-check), pgTAP, Playwright                                                                                                          |
| Email       | Resend (custom SMTP for Supabase Auth; react-email for app emails such as invitations)                                                            |
| Ops         | Sentry (cost values scrubbed), GitHub Actions, Renovate, EAS Build/Submit/Update                                                                  |
| Local       | Supabase CLI + Docker Desktop (WSL2) + Mailpit                                                                                                    |

Upgrade triggers: ROADMAP.md §Later.

## Repo structure

Planned layout. Exists today: root config, `packages/config`, `packages/domain`, `docs/`, `.github/workflows/ci.yml`. The rest is created by the step that needs it.

```
apps/
  web/                    Next.js: web UI + tRPC host (Vercel, bom1)
    app/layout.tsx        <html lang dir> set on the server, fonts, providers
    app/(auth)/           login, signup, verify, forgot, reset
    app/setup/            Smart Setup wizard + create business
    app/invite/[token]/   accept invitation
    app/b/[businessId]/   layout.tsx (RSC: getClaims + `me` bootstrap), page.tsx (Dashboard),
                          settings/{business,locations,members,roles,modules,profile}/,
                          <module>/ only once that module is released
    app/api/trpc/[trpc]/route.ts   the only API entry ([Later]: api/hooks, api/jobs)
    proxy.ts              @supabase/ssr session refresh + redirect when signed out
    components.json       shadcn, rtl: true
    vercel.json           "regions": ["bom1"]
    src/components/{ui,shell,data}/  shadcn · Sidebar/Topbar/BottomNav/BusinessSwitcher · DataTable/SplitView/FilterBar/EmptyState/Locked
    src/features/<module>/
    src/lib/{supabase/{browser,server}.ts, trpc/{client,server}.tsx, env.ts}
  mobile/                 Expo + expo-router
    app/_layout.tsx       Intl polyfills → i18n → RTL → providers
    app/(auth)/, app/(app)/(tabs)/{index,more}.tsx   M1: Home + More only
    app/(app)/business-switch.tsx
    src/components/       ~15 primitives: Screen, Text, Button, TextField, NumberField, Card, ListRow, Sheet, DirIcon, Money
    src/lib/{supabase.ts, large-secure-store.ts, trpc.tsx, rtl.ts, env.ts}
    global.css (tailwindcss + uniwind + theme.native.css), app.config.ts, eas.json, metro.config.js
packages/
  domain/     pure TS: decimal money/qty, rounding, can()/resolveEffective(), module deps,
              Smart Setup recommend(), parseNumber (Arabic digits). Units (from M2) and cost logic arrive in their phase, no stubs
  contracts/  Zod v4 DTOs, zDecimal, uuidv7, businessDate, sensitivity tags, error codes
  modules/    module manifests, capability registry, permission catalog, role templates, Smart Setup questions, terminology map
  db/         Drizzle schema (pg schema app), tenantTable(), withTenantTx(), adminDb (restricted), seeds, test factories
  api/        tRPC init, context, middlewares, routers, services, redact, audit, emails
  app-core/   React only: tRPC/Query factory, useMe/useActiveBusiness/useCan/useModuleEnabled/useModuleNav/useQuickActions,
              auth state machines, form helpers
  i18n/       locales/{en,ar}/*.json, overlays/<profile>/{en,ar}/*.json, init factory, formatters
  tokens/     tokens.ts → theme.web.css + theme.native.css
  config/     tsconfig, ESLint flat config (boundaries, RTL, money), Vitest preset
supabase/     config.toml, templates/ (auth emails), migrations/, tests/ (pgTAP), seed.sql (demo business per industry)
tests/e2e/    Playwright AR/EN smoke + cross-tenant attack tests
docs/         PRODUCT.md, ARCHITECTURE.md, DATA_MODEL.md, ROADMAP.md, DECISIONS.md, mockups/ (nothing else)
.github/workflows/{ci.yml, db-migrate.yml}
CLAUDE.md, package.json, pnpm-workspace.yaml, turbo.json, .npmrc, .gitattributes (eol=lf), .nvmrc (24), .env.example
```

### Package dependency rules (enforced by lint)

- Layer order: `domain` → `contracts` → `modules` → `db` → `api`. A package imports only packages earlier in this chain.
- `app-core` imports `domain`, `contracts`, `modules` and `i18n`. From `api` it takes types only (`import type { AppRouter }`).
- Apps never import `db` or `api`. The only exceptions are `apps/web/app/api/trpc/[trpc]/route.ts` and `apps/web/src/lib/trpc/server.tsx` (the server caller).
- No `react-dom` or `react-native` in shared packages. No `react` at all in `domain`, `contracts`, `modules` or `i18n`.
- `packages/db` and `packages/api` start with `import 'server-only'`. `adminDb` has its own lint-restricted import path.

### Platform roles & parity

- Desktop web gets dense tables, split views, filters and multi-column forms. Mobile gets quick entry, cards, sheets and a bottom nav. About 60–70% of the non-visual code is shared.
- Role and permission management, module customization, Smart Setup and invitations are web-only in M1. Mobile tells the user to manage these from the desktop.
- iOS `supportsTablet: false` in M1 because this cannot be undone after release. iPad users use the web. Native tablet layouts come [Later].
- Record every intentional web/mobile difference in this section.

## API & request flow

- **Web:** same-origin `/api/trpc` with `@supabase/ssr` cookies. `proxy.ts` (Next 16) refreshes the session. Mutations check the `Origin` header.
- **Mobile:** `https://app.<domain>/api/trpc` with `Authorization: Bearer <access_token>`, `x-business-id` and `x-app-version`. No CORS is needed.
- **Session check:** Supabase uses asymmetric JWT signing keys. The server calls only `supabase.auth.getClaims()`, which verifies locally against JWKS, for both cookies and Bearer tokens.
- **No Server Actions for data.** The tRPC router is the only write path. No `'use cache'` for business data.
- **RSC is for layouts only.** They call procedures through `createCaller` (no HTTP hop), e.g. `b/[businessId]/layout.tsx` loads `me` as `initialData`. Screens are client components. [Later]: prefetch + `HydrationBoundary` for the dashboard.
- **tRPC links per platform:** the `app-core` factory takes the link from the app. Web uses `httpBatchStreamLink`/`httpBatchLink`. Mobile uses `httpBatchLink`, or `expo/fetch` if streaming is needed.
- **Wire format:** plain JSON with no superjson. Decimals are strings, timestamps are ISO, `business_date` is `YYYY-MM-DD`.
- **Procedure bases:** `public`, `authed`, `business`. Errors are typed and carry i18n keys.
- **API evolution:** tRPC serves our own apps only. Changes are additive, and anything removed first gets a deprecation window. When `x-app-version` is below `minSupportedVersion`, the server returns a typed error and the app shows a force-update screen. EAS Update uses a fingerprint runtime.
- [Later]: REST `/v1` (OpenAPI generated from the same Zod schemas) for integrations, webhooks under `/api/hooks`, jobs under `/api/jobs`.

## Auth

- **Supabase Auth:** email + password (min 10 chars), email confirmation on, leaked-password protection (Pro, prod), new publishable/secret keys.
- **Email codes:** 6-digit OTP for signup verification, password reset and optional "sign in with a code". `otp_length=6` and `otp_expiry=600` are set explicitly in `config.toml` because project defaults vary. A shared constant `AUTH_OTP_LENGTH` holds the length. No 2FA on every login. No phone OTP at launch.
- **Flows** (state machines in `app-core`):
  - Sign up: `signUp` → `verifyOtp(type 'email')`.
  - Sign in: `signInWithPassword`, or `signInWithOtp({ shouldCreateUser: false })` → `verifyOtp`.
  - Reset: `resetPasswordForEmail` → `verifyOtp(type 'recovery')` → `updateUser`.
  - Sign out: `signOut({ scope: 'global' })`.
- **No account-existence leak.** The error "Signups not allowed for otp" is handled exactly like success ("If you have an account, we sent a code"). `signUp` with an existing email sends no code, so the signup code screen links to sign-in and reset. Supabase errors map to i18n keys by `error.code`, never by message text.
- **Code screen:** 6 cells with paste support. `autocomplete="one-time-code"` on web, `textContentType="oneTimeCode"` on iOS. The code row stays LTR inside the Arabic UI, Arabic digits are normalized, and resend waits 60 s.
- **Email templates** (in `supabase/templates`): show only the code (`{{ .Token }}`), no links. Bilingual through a Go condition on `{{ .Data.locale }}`. `user_metadata.locale` stays synced with `profiles.locale`. Templates cover signup, sign-in code, recovery, secure email change (two codes) and reauthentication (password change).
- **Email delivery:** Resend custom SMTP with SPF/DKIM/DMARC before any real user. Auth mail (e.g. `auth.mail.<domain>`) and notifications (e.g. `notify.<domain>`) use separate subdomains and preferably separate API keys.
- **Mobile session:** supabase-js with `LargeSecureStore`: an AES key in expo-secure-store (2 KB limit) and the encrypted session in AsyncStorage. `android.allowBackup: false`. If decryption fails, the app clears the session and treats the user as signed out. Auto-refresh starts and stops with AppState. `detectSessionInUrl: false`.
- **Profiles** are created by an upsert in the `me` procedure, not by a trigger on `auth.users`.
- **Invitations:** our own `business_invitations` table, not `auth.admin.inviteUserByEmail` (DATA_MODEL.md §4 business_invitations). Accepting requires a matching verified email. Rate-limited with DB counters (e.g. 20/day per business, 3 resends per invite) and audited.
- **Invariants:** every business has at least one active owner, and ownership transfer is an explicit action.
- **Account deletion** (in-app, M1, an Apple requirement): blocked while the user is the sole owner of a business that has other members (transfer ownership or delete the business first). Steps: deactivate memberships → anonymize the profile (never hard-delete it) → `auth.admin.deleteUser`. Works because actor columns have no FK to `auth.users` (DATA_MODEL.md §1.3).
  - Business deletion and data export semantics: DATA_MODEL.md §4 (businesses). No UI for them in M1.
- **Staff PIN on a shared device** [Later]: the data model allows a member without an auth account from M1 (DATA_MODEL.md §4 business_members). The PIN login UI comes later (ROADMAP.md).
- [Later]: Send Email Hook, TOTP MFA, social login, phone OTP, biometric lock.

## Tenancy & security

### Active business

- On web the active business is in the URL (`/b/[businessId]`), so several tabs can each open a different business. On mobile it is persisted on the device.
- It is sent as `x-business-id`. The server checks active membership in the DB on every request, so a removed member is rejected on their next request.
- It is never a JWT claim (goes stale) and never a cookie (shared across tabs). `profiles.last_business_id` picks where to go after login.

### Database access

- Drizzle + postgres.js through the Supavisor transaction pooler (port 6543, `prepare: false`), logging in as `bizcost_api.<project_ref>`. Fallback: a dedicated pooler or a direct connection. To be proved in Step 0c.
- `bizcost_api`: no BYPASSRLS, not a superuser, does not own tables. It **fails closed**: a query without tenant context returns zero rows. Provisioning (NOLOGIN in migrations, default privileges, timeouts, per-environment password from a secret via §Runbooks): DATA_MODEL.md §1.1.
- Schema `app` is not exposed to the Data API (PostgREST), and `anon`/`authenticated` get zero grants on it.
- `withTenantTx(ctx, fn)` is the **only** data entry point. Its first statement sets `app.user_id`, `app.business_id` and `app.request_id` with `set_config(…, true)` (transaction-local). Lint bans raw `SET`, and a test asserts the context is empty after each transaction.
- The transaction pooler supports no prepared statements, LISTEN or session locks. Design around this.

### RLS

- Every tenant table has ENABLE + FORCE RLS and one generated policy (FOR ALL, so it acts as USING and WITH CHECK):
  ```sql
  business_id = (select app.current_business_id())
  and (select app.is_active_member(app.current_business_id()))
  ```
  No row column is passed to a function, so Postgres evaluates it once per query as an InitPlan. pgTAP/EXPLAIN tests assert InitPlan and no SubPlan.
- Identity tables (`businesses`, `business_members`, `business_invitations`) have their own membership policies. Creating a business and accepting an invitation go through narrow SECURITY DEFINER functions.
- RLS handles **tenant isolation only**. Roles, permissions, module gates and redaction live only in TypeScript, so no rule is written twice.
- A CI catalog check asserts that every table with `business_id` has FORCE RLS + the standard policy. The schema also enforces tenancy with composite FKs `(business_id, x_id)` (DATA_MODEL.md §1.2).

### SECURITY DEFINER functions

- Only in schema `app`, never `public` (which would expose them via `/rpc`). `SET search_path = ''` with fully qualified names. Explicit owner (`postgres`), which also stops RLS recursion on `business_members`.
- `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`, then `GRANT EXECUTE` to `bizcost_api` only. pgTAP `grants` checks no `app` function is executable by PUBLIC/anon/authenticated and every definer function has `search_path` in `proconfig`.

### Secrets & server-only code

- The service/secret key is server-only, used for exactly: Auth admin, Storage signed URLs, background jobs. Sentry scrubs cost values. The AI layer [Later] only creates drafts a human confirms, and its output passes through redaction.

### Storage

- One private bucket; paths `{business_id}/{entity}/{uuidv7}`. The bucket sets `file_size_limit` and `allowed_mime_types`.
- Uploads and downloads use only signed URLs that the API issues after a permission check. TTL is short because a URL stays valid after membership is revoked. Orphans from unfinished uploads are cleaned up [Later, with background jobs].

### Network exposure

- `*.supabase.co` was reportedly blocked in the UAE (Sep 2025, ~18 days) and in India (Feb–Mar 2026). So prod uses a Supabase custom domain (e.g. `auth.<domain>`) before the first store build; `EXPO_PUBLIC_SUPABASE_URL`, the web client and signed URLs all use it.
- CI fails if `supabase.co` appears in a web or mobile bundle. How this interacts with staging builds is open (ROADMAP.md §Open, with deadline).
- Option: proxy web auth calls through route handlers on `app.<domain>`. §Runbooks covers a region move or a blocking incident.

## Permissions, modules & capabilities

- Three independent server gates: **plan** (placeholder; only `businesses.plan` exists in M1) → **module enabled** → **permission**.
- **Capabilities** are business-level flags from Smart Setup (e.g. `has_team`, multi-location, `vat_registered`, `keeps_stock`, `uses_machines`). They hide fields, sections and pickers inside screens and are not security gates.
- The schema does not depend on capabilities, so turning one on needs no data migration. Product meaning: PRODUCT.md §5; storage: DATA_MODEL.md §4 business_capabilities.
- Middleware order: `authed → businessScoped → requireModule → requirePermission → handler → redact`.
- Permission keys look like `module.resource.action` and are declared in manifests. Role templates are copied per business as editable roles. Members can have allow/deny overrides and a location scope. Evaluation is pure (`resolveEffective`, `can`) in `domain`.
- M1 UI covers only templates, assigning a role and editing a role's permissions (ROADMAP.md).
- **Redaction:**
  - `.output()` is mandatory on every procedure (CI check). Zod objects strip unknown keys.
  - Sensitivity categories: `cost`, `profit_margin`, `supplier_price`, `payroll`, `employee_pii`. They are grouped so a hidden value cannot be derived from visible ones (e.g. price + margin reveals cost). Tags go in Zod v4 metadata.
  - The `redact` middleware reads the output-schema metadata automatically. A hidden field is removed and listed in `meta.redacted`, and the UI shows a lock instead of a misleading 0.
  - Aggregates such as dashboard profit are withheld in `services`.
  - Redaction covers lists, details, reports, exports, search, errors, logs and telemetry.
  - Filtering, sorting, grouping, searching or exporting on a sensitive field the user cannot see returns **FORBIDDEN**, never a silent ignore.
  - An oracle test runs for each role template, including the lowest-privilege Employee (staff) template.
- **Audit:** every write adds an `audit_log` row with the actor and `request_id`.

### Modules

The manifest in `packages/modules` is the single source for the sidebar, mobile tabs, "+", Smart Setup, API guards and Customize BizCost. Illustrative shape:

```ts
{ id: 'orders', availability: 'released' | 'planned', deps: ['products'],
  nav, quickActions, permissionKeys, sensitiveFields,
  requiresCapabilities, defaultsByBusinessType, terminologyProfile }
```

- Nav, tabs and "+" show a module only when it is `released`, enabled for the business and permitted. In M1 only Dashboard and Settings are released.
- There are no placeholder routes. A planned module's enabled flag is saved but stays invisible.
- Disabling a module hides it and never deletes its data. Customize warns about dependencies.

## Numbers, money, units & time

- **Column types:** numeric only (no float, double or `money`); table in DATA_MODEL.md §1.4.
- In code: decimal.js with branded types in `domain`, and decimal strings on the wire (`zDecimal`). Lint bans `Number()`/`parseFloat` on money. Heavy aggregation runs in SQL.
- **Two rounding policies** (in `domain`):
  1. Documents (purchase/sale/invoice lines, VAT): round half-up to the currency minor unit from an ISO-4217 table (AED 2; KWD/BHD/OMR 3).
  2. Cost engine (unit cost, recipes, WAC): never round. Store at `numeric(28,12)` and round only for display.
- **Display:** round with decimal.js to the display digits first, then call Intl with min = max fraction digits, because Hermes may coerce strings to float. A golden test compares web and Hermes output.
- **Currency, time:** `businesses.currency` (default AED) and a `currency` column on every financial document; multi-currency/FX [Later]. UTC `timestamptz` + `business_date` per document (DATA_MODEL.md §1.4–1.5).
- **Input:** `parseNumber` in `domain` normalizes Arabic-Indic digits (٠-٩, ۰-۹) and the separators ٫ ٬.
- **Units** (Phase 2): each material has one base unit in one dimension (mass, volume, count, length, area, time). Standard conversions live in code; packaging conversions are stored exactly per material; cross-dimension needs an explicit factor. Tables: DATA_MODEL.md §6.

## Data fetching & caching

- tRPC + TanStack Query are configured once in `app-core`, so both platforms use the same hooks.
- `QueryClientProvider` is keyed by `businessId`, so each business gets a fresh cache and in-flight queries cannot leak across businesses. Sign-out clears everything.
- No persisted cache: cost data never stays on the device. Offline is not required.
- **Writes:** client-generated UUIDv7 IDs; idempotent creates and `version`-based optimistic concurrency, both returning a typed CONFLICT on mismatch (rules: DATA_MODEL.md §1.2). Optimistic UI only for simple keys; financial documents wait for the server.
- `staleTime` is about 30 s, and invalidation uses tRPC `pathKey`.
- **Stale `me`/permissions:** invalidate `me` on any FORBIDDEN, refetch on window focus, and compare the `permissions_version` response header (from `business_members.permissions_version`) with the cached value.
- Web keeps filter and sort state in the URL (nuqs) and uses cursor pagination. Mobile wires `focusManager` to AppState and `onlineManager` to NetInfo.

## i18n & RTL

- i18next + react-i18next on both platforms. Files: `packages/i18n/locales/{en,ar}/{common,auth,setup,settings,nav,modules,units,errors}.json`. Keys are typed via `CustomTypeOptions`. Arabic uses 6 plural forms. CI fails when an Arabic key is missing.
- Locale order: `profiles.locale` → `bz_locale` cookie → Accept-Language (web) or expo-localization (mobile). No locale segments in URLs.
- **Next server:** one i18next instance per request via `createInstance()` inside React `cache()`. Never a global `changeLanguage` on the server (lint rule). The server passes the locale and only the needed namespaces to the client `I18nProvider`. The root layout sets `<html lang dir>`, so there is no flash.
- **Terminology overlays** per profile (general, food, maker, workshop, factory, projects) replace **whole sentences** and are merged at load. Nouns are never interpolated into sentences. Wording: PRODUCT.md §13.
- **Formatting:** Intl with `ar-AE-u-nu-latn` (Latin digits by default). Currency comes from the business.
- **Hermes (mandatory):** before i18next init, import `@formatjs/intl-getcanonicallocales`, `@formatjs/intl-locale/polyfill`, `@formatjs/intl-pluralrules/polyfill-force` and the ar/en locale data. Test Arabic plurals for 0, 1, 2, 3, 11 and 100, plus NumberFormat for `ar-AE-u-nu-latn` in AED.
- **RN RTL:** `supportsRTL` + `supportedLocales ['en','ar']`. Switching direction calls `I18nManager.allowRTL/forceRTL` then `Updates.reloadAsync()` behind a restart notice. Test in dev builds only.
- **Logical layout only:** lint bans physical classes (`ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`/`text-right`/`rounded-l|r`/`border-l|r`) and physical RN props (`marginLeft`…). Directional icons use `DirIcon`. Numbers, TRN and codes go in `<bdi>`/`dir="ltr"`. Amounts use `tabular-nums`.
- **shadcn:** set `rtl: true` in `components.json` **before** the first `shadcn add` (otherwise run `shadcn migrate rtl`). Add the Radix `DirectionProvider`. Review Sidebar, Calendar and Pagination by hand. Set the vaul direction and the sonner position manually.

## Styling

- `packages/tokens/src/tokens.ts` is the single source: semantic colors for light and dark (incl. `profit`, `loss`, `chart-1..6`), radii and fonts. It generates:
  - `theme.web.css`: Tailwind v4 `@theme inline` + `:root`/`.dark` variables for shadcn.
  - `theme.native.css`: Uniwind `@layer theme { :root { @variant light {…} @variant dark {…} } }`.
- A CI check makes sure every variable exists in both files and both themes.
- Mobile uses only standard utilities inside the ~15 primitives, so moving to NativeWind v5 stays a small refactor. Icons have the same names in lucide-react and lucide-react-native.
- Dark tokens are defined now. Dark-mode polish comes [Later].

## Environments & deployment

| Env           | Where                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Local         | Supabase CLI + Docker Desktop (WSL2), Mailpit for codes. Fallback: hosted dev project (decided on day 1)      |
| Staging, Prod | Supabase projects in ap-south-1 (there is no Middle East region, and the region cannot change later) + Vercel |

- **Supabase plans are per organization:** either two orgs (Free for dev/staging, Pro for prod) or both projects in one Pro org (~$35+/mo). Start on Free. Upgrade prod before the first real customer, because the custom domain and leaked-password protection need Pro. A Free staging project pauses when idle. PITR before the first paying customer. Open items: ROADMAP.md §Open, with deadline.
- **Config:** `supabase/config.toml` holds the OTP settings, templates, rate limits and exposed schemas (without `app`). Apply it to hosted projects with `supabase config push`, never by hand in the dashboard.
- **Vercel Pro:** one project with functions pinned to `bom1` in `vercel.json` (the default is iad1). A smoke check verifies the region after deploy. Not dxb1: the DB is in Mumbai, and dxb1 is reportedly under maintenance.
- **Serverless pooling:** postgres.js `max: 1` + `idle_timeout`, and `attachDatabasePool` (@vercel/functions) with Fluid compute. Role-level `statement_timeout`.
- **EAS:** Build (iOS without a Mac), Submit and Update. Channels: development, preview, production. `runtimeVersion` policy `fingerprint`. Internal testing on TestFlight and the Play internal track.
- **Migrations:** Drizzle schema → `drizzle-kit generate` into `supabase/migrations`, applied **only via the Supabase CLI** (`db reset` locally, `db push` from `db-migrate.yml`, manual approval for prod). Full rules: DATA_MODEL.md §1.1.
- **Heavy work** [Later]: cost recomputation and reports need background jobs (pgmq, pg_cron or Vercel Cron) before those phases (ROADMAP.md).

### Runbooks (written in Step 9 as subsections here)

- Set or rotate the `bizcost_api` password per environment, and rotate keys.
- Migrations and restore.
- Region move (e.g. to Frankfurt) and a communication plan for a `*.supabase.co` block.

## Testing & CI

GitHub Actions: `ci.yml` (every PR) and `db-migrate.yml` (applies migrations; manual approval for prod).

| Check                         | Covers                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck, lint               | Package boundaries, server-only, no float money, no raw SET, no server `changeLanguage`, logical RTL classes/props                                                                  |
| Vitest (+ fast-check)         | `domain`: decimals, rounding, permission engine, `recommend()` per industry (units from M2)                                                                                         |
| pgTAP                         | RLS isolation (`rls_*`, 2 businesses × 2 users), `grants` (SECURITY DEFINER rules, no UPDATE/DELETE on `audit_log`), `catalog_coverage`, InitPlan in EXPLAIN, account deletion path |
| Migration drift               | Drizzle schema vs `supabase/migrations`                                                                                                                                             |
| Contract checks               | `.output()` on every procedure, redaction oracle per role template, FORBIDDEN on sensitive filter/sort                                                                              |
| Static checks                 | Missing Arabic keys, token parity (web/native), no `supabase.co` in bundles                                                                                                         |
| Playwright                    | AR (RTL) + EN smoke at 375/768/1440 px                                                                                                                                              |
| Cross-tenant attacks          | 2 businesses × 2 users through the API, PostgREST with a real JWT, and Storage paths                                                                                                |
| Mobile (Expo spike + devices) | Arabic plurals, Intl on Hermes, golden rounding web vs Hermes, RTL restart, LargeSecureStore failure path                                                                           |

## Key risks

| Risk                                                                       | Mitigation                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `*.supabase.co` blocked in the UAE/India                                   | Custom domain, bundle check, region-move runbook                                                                   |
| Functions drift to iad1                                                    | `vercel.json` bom1 + region smoke check                                                                            |
| Tenant context leaks across pooled connections; data exposed via PostgREST | `withTenantTx` + `set_config(…, true)` + empty-context test; `app` not exposed, zero grants, PostgREST attack test |
| RLS slow on large ledgers                                                  | InitPlan policy, indexes starting with `business_id`, EXPLAIN on a big seeded business                             |
| Hidden values inferred (derived fields, aggregates, filters, telemetry)    | Mandatory `.output()`, automatic redact, FORBIDDEN on sensitive filters, scrubbing                                 |
| Access token stays valid after global sign-out                             | Membership check per request; consider a shorter JWT lifetime                                                      |
| Metro + pnpm on Windows                                                    | Hoisted linker, single React, to be proved in the Expo spike (Step 4)                                              |
| RN RTL bugs, Hermes Intl gaps                                              | Restart flow, FormatJS polyfills, real-device tests                                                                |
| Uniwind is young                                                           | Standard utilities, ~15 primitives; NativeWind v5 fallback                                                         |
| OTP email deliverability to UAE corporate mail                             | Resend SMTP, SPF/DKIM/DMARC, separate subdomains, bounce monitoring                                                |
| Solo founder building two UIs                                              | Shared logic packages, mobile limited to quick entry and dashboards                                                |
| App Store review                                                           | In-app account deletion, reviewer demo account, purchase-link rules (3.1) once billing exists                      |
| Vendor lock-in; Windows dev env                                            | See §Overview exit paths; WSL2 memory, `eol=lf`, long paths, EAS free-tier queues                                  |
