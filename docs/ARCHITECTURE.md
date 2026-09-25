# BizCost Architecture

Purpose: technical system design, repo structure and engineering conventions for BizCost (web + mobile + shared backend).
Last updated: 2026-09-26

**Status:** the repo scaffold (Step 0a), the data foundation (Step 1: `packages/db`, `supabase/` migrations and pgTAP tests), the API core (Step 2: `packages/contracts`, `packages/modules`, `packages/api`, and `apps/web` as the API host), web auth (Step 3), businesses & Smart Setup (Step 5) and web settings (Step 6) exist. Everything below is **DECIDED** design. Items tagged **[Later]** are planned but not part of M1. Product rules are in PRODUCT.md, tables in DATA_MODEL.md, steps and deadlines in ROADMAP.md, and the reasons behind each choice in DECISIONS.md.

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

Planned layout. Exists today (after Step 6): root config, `packages/{config,domain,contracts,modules,db,api,app-core,i18n,tokens}`, `apps/web` (root layout, `(auth)` pages login/signup/verify/forgot/reset and `invite/[token]`, `(app)` pages home, account, setup, `b/[businessId]` and its `settings/`, `not-found`/`error`, `proxy.ts`, `app/api/trpc/[trpc]/route.ts`, `src/{components,features,lib}`), `supabase/` (incl. `templates/`), `tests/e2e`, `docs/`, `.github/workflows/ci.yml`. The rest is created by the step that needs it.

```
apps/
  web/                    Next.js: web UI + tRPC host (Vercel, bom1)
    app/layout.tsx        <html lang dir> set on the server, fonts, providers
    app/(auth)/           login, signup, verify, forgot, reset
    app/setup/            Smart Setup wizard + create business
    app/(auth)/invite/[token]/   accept invitation (open signed in or not)
    app/b/[businessId]/   layout.tsx (RSC: `me` + `business.context`, one QueryClient per business), page.tsx (business home; Dashboard in Step 7),
                          settings/{business,locations,members,roles,modules,language}/ (own layout until Step 7),
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
              parseNumber (Arabic digits). Units (from M2) and cost logic arrive in their phase, no stubs
  contracts/  Zod v4 DTOs, zDecimal, uuidv7, businessDate, sensitivity tags, error codes
  modules/    module manifests, capability registry, permission catalog, role templates, Smart Setup (setup/: versioned questions
              with skip logic, normalizeAnswers/parseSetupAnswers, recommend(), applyAdjustments/toggleSetupItem, review data)
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

- Layer order: `domain` → `contracts` → `modules` → `db` → `api`. A package imports only packages earlier in this chain (`no-restricted-imports` per layer; probe tests in `packages/config/eslint/boundaries.test.js`).
- `app-core` imports `domain`, `contracts`, `modules` and `i18n`. From `api` it takes types only (`import type { AppRouter }`).
- `i18n` imports only `domain` types. `modules` imports `i18n` for message keys (`I18nKey`), and `api` for server-side texts (the default location and role names of a new business).
- Apps never import `db` or `api`. The only exceptions are `apps/web/app/api/trpc/[trpc]/route.ts` and `apps/web/src/lib/trpc/server.tsx` (the server caller).
- No `react-dom` or `react-native` in shared packages. No `react` at all in `domain`, `contracts`, `modules` or `i18n`.
- `packages/db` and `packages/api` start with `import 'server-only'`. `adminDb` has its own lint-restricted import path.
- Inside `packages/api/src`, only `context.ts` may import `createDb`/`withTenantTx`; everything else reaches the database through `ctx.tenantTx`/`ctx.tx`.
- Only `packages/api/src/services/account.ts` may import `src/admin/*` (the Supabase Auth admin API with the secret key).
- The pure packages (`domain`, `contracts`, `modules`, `i18n`, `app-core`) are marked `sideEffects: false`, so the web bundle drops the modules a page does not use (e.g. the API DTOs and classic Zod).

### Platform roles & parity

- Desktop web gets dense tables, split views, filters and multi-column forms. Mobile gets quick entry, cards, sheets and a bottom nav. About 60–70% of the non-visual code is shared.
- Role and permission management, module customization, Smart Setup and invitations are web-only in M1. Mobile tells the user to manage these from the desktop.
- iOS `supportsTablet: false` in M1 because this cannot be undone after release. iPad users use the web. Native tablet layouts come [Later].
- Record every intentional web/mobile difference in this section.

## API & request flow

- **Web:** same-origin `/api/trpc` with `@supabase/ssr` cookies. `proxy.ts` (Next 16) refreshes the session. Mutations check the `Origin` header.
- **Mobile:** `https://app.<domain>/api/trpc` with `Authorization: Bearer <access_token>`, `x-business-id` and `x-app-version`. No CORS is needed.
- **Session check:** Supabase uses asymmetric JWT signing keys. The server calls only `supabase.auth.getClaims()`, which verifies locally against JWKS, for both cookies and Bearer tokens. An `Authorization` header wins over cookies. Only ES256/RS256 tokens are accepted: an HS* token is rejected before `getClaims()`, which would otherwise ask the Auth server and accept tokens signed with the legacy JWT secret (D-056). Before `getClaims()`, a token must be three parts with a JSON header naming ES256/RS256 and a `kid` (so auth-js verifies against the JWKS and never falls back to asking the Auth server) and a JSON payload with a numeric `exp`; the cookie path reads the stored session only to take its access token and checks it the same way. Anything `getClaims()` returns or throws for a bad token (bad signature, expiry, key-type mismatch, malformed JSON) is 401 and is not reported; only an unreachable Auth server (JWKS or refresh) is `internal`. The claims must have `role` and `aud` `authenticated`, a UUID `sub` and `is_anonymous` false. On the cookie path `@supabase/ssr` may refresh an expiring session and send the new cookies on the same response.
- **No Server Actions for data.** The tRPC router is the only write path. No `'use cache'` for business data.
- **RSC is for layouts only.** They call procedures through `createCaller` (no HTTP hop), e.g. `b/[businessId]/layout.tsx` loads `me` as `initialData`. Screens are client components. [Later]: prefetch + `HydrationBoundary` for the dashboard.
- **tRPC links per platform:** the `app-core` factory takes the link from the app. Web uses `httpBatchStreamLink`/`httpBatchLink`. Mobile uses `httpBatchLink`, or `expo/fetch` if streaming is needed.
- **Wire format:** plain JSON with no superjson. Decimals are strings, timestamps are ISO, `business_date` is `YYYY-MM-DD`.
- **Procedure bases:** `public`, `authed`, `business`. Errors are typed and carry i18n keys.
- **As built in Step 2 (`packages/api`, D-057):**
  - `createFetchHandler(deps)` (fetch Request → Response) is mounted by `apps/web/app/api/trpc/[trpc]/route.ts`. A batch may hold at most `API_MAX_BATCH_SIZE` (20, `@bizcost/contracts`) calls, else 400 before any procedure runs; client batch links set `maxItems` to it. `createContext({ req, resHeaders, deps, router })` gives each request a UUIDv7 `requestId`: response header `x-request-id`, passed to `withTenantTx`, so every audit row of the request carries it. A server-side caller (the RSC caller, Step 3) builds the context the same way with `appRouter` and calls `createCallerFactory(appRouter)(ctx)`.
  - Middleware order on every procedure: `mapErrors → appVersionGate → originCheck → [authed → openAccount | businessScoped] → redact → [requireModule → requirePermission] → output validation → handler`. `openAccount` (every `authedProcedure`, once per request) refuses a deleted account whose token has not expired yet: an anonymized profile is `unauthorized` (D-065). A contract test walks every procedure of `appRouter`: Zod `.output()`, redact placement, sensitive fields only in business procedures that return `withMeta()`.
  - The context holds no database pool: `ctx.tenantTx(businessId | null, fn)` runs `withTenantTx` as the verified caller with the request id (UNAUTHORIZED without a session), so a procedure cannot act as another user. `authed` adds `ctx.auth`. `business` reads `x-business-id` (not a UUID → `validation`); loads membership, role, role permissions, overrides, member locations, enabled modules, stored capabilities and `businesses.vat_registered` in ONE statement inside `withTenantTx` (memoized per request, so a batch loads it once); answers "not a member" and "no such business" with the same FORBIDDEN; adds `ctx.access` and `ctx.tx(fn)`; sends `x-permissions-version`. Procedures reach the database only through `ctx.tx`/`ctx.tenantTx` (lint: only `context.ts` imports `withTenantTx`/`createDb`).
  - `requireModule(id)`: released and enabled, else MODULE_DISABLED. Core modules are on unless a `business_modules` row switches them off; optional modules are on only through an enabled row; Dashboard and Settings are always on (D-059). `requirePermission(key)`: `can()`, else FORBIDDEN. `assertQueryable(ctx, fields)`: FORBIDDEN when a filter/sort/group/search/export field has a hidden category.
  - Errors: `error.data` carries `appCode` (`APP_ERROR_CODES`) and `i18nKey` (`errors.<code>`). Database failures are mapped by SQLSTATE (23505/40001/40P01 → conflict; 23514/23503/23502/22P02/22001 → validation; 42501 → forbidden), with the original kept only as `cause`. In production the message is the app code and there is no stack. `app_version_unsupported` is HTTP 412; `module_disabled` and `reauth_required` are 403; `sole_owner` is 409.
  - App-version gate: an `x-app-version` below `MIN_SUPPORTED_APP_VERSION`, or not a valid semver, gets `app_version_unsupported`. Web sends no header.
  - Origin check: every mutation without an `Authorization` header (cookie session or signed out) needs an `Origin` equal to one of `APP_ORIGINS`, else FORBIDDEN. Bearer requests skip it.
  - Routers: `health` (public: `{ok, region: VERCEL_REGION ?? 'local', version}`), `me` (authed, memoized per request so a batch reads once), `business.context` (business), `account.updateProfile` and `account.delete` (authed, Step 3; see §Auth). `me` creates the profile if missing (display name = email local part; locale from `user_metadata.locale`, else `ar`; an existing profile is never overwritten) and lists the businesses the caller can open (active memberships of live businesses), each with its role template read in that business's own `withTenantTx` (roles are tenant rows).
  - Idempotent creates: `insertIdempotent(tx, table, values)` in `packages/db` (DATA_MODEL.md §1.2) throws `ConflictError`, which the API maps to CONFLICT.
- **As built in Step 5 (D-074–D-079):**
  - `business.createFromSetup` (authed, not business-scoped; `services/setup.ts`): input `{ businessId (client UUIDv7), legalName (1–100 characters, no control characters), locale, questionSetVersion, answers, adjustments }`. The server checks the answers strictly (`parseSetupAnswers`: VALIDATION for a hidden question or option, a missing answer, a broken exclusive option, an unknown id or another question-set version), recomputes `recommend()` and applies the review adjustments with `applyAdjustments` (VALIDATION for an unknown id, Dashboard/Settings, a duplicate, or a module that needs VAT while VAT is off). Then ONE `withTenantTx` in the new business: `app.create_business` (business, Owner role, the caller's Owner membership; at most 10 per user in 24 hours, SQLSTATE `BZ429` → `rate_limited`), business type, terminology profile, VAT status and `setup_completed_at`, `setup_answers`, one `business_capabilities` row per stored capability (`source` = `user` where the review changed it), the D-059 `business_modules` rows, the default location named in the caller's language, the other six role templates with their `role_permissions`, and `profiles.last_business_id`.
  - Idempotent on `businessId`: `setup_answers.request_hash` keeps a SHA-256 fingerprint of the canonical payload. The same payload again returns the same business, also when two identical requests race (the second one's unique violation, or its daily-limit error for the last business the limit allows, is answered from the saved fingerprint); another payload, or an id of a business the caller cannot see, is CONFLICT.
  - `business.context` also returns `terminologyProfile`. SQLSTATE 22021/22P05 (a character Postgres text cannot hold) map to `validation`; the name DTOs refuse control characters first.
- **As built in Step 6 (web settings, D-080–D-088):**
  - Routers: `business.profile`/`updateProfile`/`setDefaultLocale` (settings.business.view / .edit), `business.logoUploadUrl`/`setLogo`/`removeLogo` (.edit; §Storage), `business.customization`/`customize` (settings.modules.manage), `location.*` (settings.locations.manage and capability `multi_location`), `member.list` (settings.members.view), `member.changeRole`/`remove` (settings.members.manage), `member.leave` (any member but the owner, no permission or capability needed), `member.transferOwnership` (the owner, with a sign-in within 600 s like account deletion), `role.list`/`updatePermissions` (settings.roles.manage), `invitation.list`/`create`/`resend`/`revoke` (settings.members.view / .manage), `invitation.preview` (public) and `invitation.accept` (authed). Team, role and invitation procedures need capability `has_team` (`requireCapability` → CAPABILITY_DISABLED), except `member.leave`, preview and accept.
  - "No access beyond your own" (`canGrant`, services/team-rules.ts): a caller who is not the owner may invite with, resend, cancel, assign or take away only roles whose permissions they all hold, may remove only such members, and may edit only a role that grants nothing beyond their own access (and add or remove only keys they hold). A role that grants a key must also grant what it needs (`PERMISSION_NEEDS` in `@bizcost/modules`: editing needs seeing; VALIDATION). Saving a role bumps `permissions_version` for its members. Nobody changes their own role or the Owner role; ownership moves only by a transfer (the old owner becomes Admin).
  - Pending invitations follow their sender: leaving or being removed revokes the invitations the person sent; after a role change, a role edit or a transfer, the API revokes every pending invitation its sender could not send now (no longer allowed to invite, or a role beyond their access), and `app.accept_invitation` checks the sender again.
  - `me` copies the account's verified email (the token's `email` claim) to the caller's active memberships when it changed (`business_members.email`, D-083), the way a new name is copied (D-065).
  - Emails of the API (invitations) go through an `EmailSender` (`packages/api/src/email`, server-only): `EMAIL_TRANSPORT=smtp` sends with nodemailer to `SMTP_HOST`/`SMTP_PORT` (locally the stack's Mailpit, `[local_smtp] smtp_port = 54325`), `RESEND_API_KEY` + `EMAIL_FROM` use the Resend HTTP API (production). Every send is bounded to 10 s in all and happens after the transaction commits, never inside one (a slow provider must not hold the request's only pooled connection or the business's locks). Bodies, links and tokens are never logged; a failure is `internal` with only the transport's error name and code. Templates are bilingual inline-styled HTML + text in TypeScript (`emails` namespace), with the brand of `supabase/templates`.
- **API evolution:** tRPC serves our own apps only. Changes are additive, and anything removed first gets a deprecation window. When `x-app-version` is below `minSupportedVersion`, the server returns a typed error and the app shows a force-update screen. EAS Update uses a fingerprint runtime.
- [Later]: REST `/v1` (OpenAPI generated from the same Zod schemas) for integrations, webhooks under `/api/hooks`, jobs under `/api/jobs`.

## Auth

- **Supabase Auth:** email + password (the rule below), email confirmation on, leaked-password protection (Pro, prod), new publishable/secret keys.
- **Password rule** (D-072): a new password (sign-up, reset, change) has at least 8 characters, an ASCII letter (a-z, A-Z) and an ASCII digit (0-9), and at most 72 UTF-8 bytes (bcrypt). The Auth server enforces it: `[auth] minimum_password_length = 8` and `password_requirements = "letters_digits"` in `config.toml` (hosted projects get it with `supabase config push`; locally the Auth container reads it only when recreated: `pnpm exec supabase stop && pnpm exec supabase start`, data is kept). The client applies the same rule first: `AUTH_PASSWORD_MIN_LENGTH` (`@bizcost/contracts`) and `newPasswordSchema` / `passwordChecks` (app-core); a test compares both settings with config.toml. The Auth server counts `minimum_password_length` in UTF-8 bytes, so for Arabic letters or emoji it is looser than the client, which counts characters (code points) and is deliberately stricter (a direct API call can set, say, a 5-character mostly Arabic password); the checklist and the schema share `passwordChecks`, so they always agree. Arabic letters and Arabic-Indic digits do not count, and passwords are never normalized. Sign-in only requires a password, so older passwords keep working. Under each new-password field (web `PasswordRules`): the hint with "(a-z, 0-9)" in `<bdi dir="ltr">` and a live checklist (icon + color per rule; one polite announcement when the whole rule becomes met or unmet). The "needs a letter and a number" error is plain text, so its Arabic range sits between LRI and PDI marks; the ranges never break across lines (`whitespace-nowrap` on the `<bdi>`, and in the error a no-break space and a word joiner after each hyphen; e2e checks the drawn order and one line). A `weak_password` answer maps by `reasons` (`length`, `characters`, `pwned`) to a message under the password field.
- **Email codes:** 6-digit OTP for signup verification, password reset and optional "sign in with a code". `otp_length=6` and `otp_expiry=600` are set explicitly in `config.toml` because project defaults vary. A shared constant `AUTH_OTP_LENGTH` holds the length. No 2FA on every login. No phone OTP at launch.
- **Flows** (reducers + small controllers in `app-core/src/auth`, with an injected supabase-js client; unit-tested with a fake):
  - Sign up: `signUp` (with `data.locale`) → `verifyOtp(type 'email')`.
  - Sign in: `signInWithPassword`, or "send me a code": `signInWithOtp({ shouldCreateUser: true, data: { locale } })` → `verifyOtp(type 'email')`. A code request for an address without an account creates it (D-062).
  - Reset (D-071): `resetPasswordForEmail` → the reset screen asks for the code only → `verifyOtp(type 'recovery')`, which signs the user in → the user chooses: a new password (`updateUser({ password })`, sent only by the flow that verified the code and only through the session it created: same user and `session_id` claim in `getSession`) or straight in. When the code is what confirmed the address (`email_confirmed_at` not earlier than `recovery_sent_at`), a new password is required and there is no choice. Opened again after the code (reload, Back): still signed in → "Continue"; otherwise, or when a password was required, this device is signed out and the user asks for a new code. A lost session signs this device out the same way.
  - "Confirm it's you" (D-063): `signInWithOtp` to the user's own email (`shouldCreateUser: false`) → `verifyOtp(type 'email')`. Used before `updateUser({ password })` on the account page and when `account.delete` answers `reauth_required`. `reauthenticate()` is not used: Supabase checks its nonce only for sessions older than 24 hours.
  - Change email: `updateUser({ email })` → one `verifyOtp(type 'email_change')` per address (current and new; secure email change).
  - Resend waits `AUTH_RESEND_COOLDOWN_SECONDS` (60, `[auth.email] max_frequency`).
  - "Too soon" (D-073): Supabase emails an address once per `max_frequency` across sign-up and sign-in codes and resets. A code request or resend answered `over_email_send_rate_limit` still looks sent (D-062) and is sent again once, unseen, at the wait the message states (its only use of message text; clamped to 1–65 s, else the cooldown; plus 1 s), while the code screen is shown (`Flow.start`, run by `useFlow`; leaving the page cancels it), never twice. `requestPasswordReset` / `requestSignInCode` / `signInWithPassword` return `retryAt`, handed to `/reset` or `/verify` with the pending code; "Send a new code" waits for the retry plus the cooldown, and a retry on time leaves that countdown unchanged. Not retried when the request's `sent` (this tab's pending entry for the same purpose and address, under a cooldown old, no retry planned, not used) shows the email inside the window is this tab's own: its code still works and the usual countdown starts. `signUp` hides the answer only in that case; any other rate limit on sign-up is shown (D-062 (3)).
  - Sign out (D-066): the header ends this device's session (`scope: 'local'`); "Sign out everywhere" on the account page ends all of them (`scope: 'global'`).
- **No account-existence leak in the screens** (D-062). A registered and a new address see the same screens and, for sign-up and "send me a code", get the same Auth answer: `[auth.sms] enable_confirmations = true` makes Supabase answer an existing email's sign-up like a new one, and code requests create missing accounts. `signUp` with an existing email sends no code, so the sign-up code screen tells everyone that a registered address gets no code, with a link to sign in, and links to reset (D-073). Asking twice in one tab looks the same for both (D-073). Still revealed by Supabase's public endpoints (accepted, listed in D-062): the per-address email rate limit (a second request within 60 s is answered 429 only for an address that was emailed; the screens show it only as a longer countdown, or the sign-up rate-limit message, when the first request came from another tab, device or kind of code, D-073) and response timing, and `email_exists` on an authenticated email change. CAPTCHA (Turnstile) on sign-up, code and reset before the first real user. Supabase errors map to i18n keys by `error.code`, never by message text (unknown → `errors.internal`).
- **Code screen:** 6 cells with paste support. `autocomplete="one-time-code"` on web, `textContentType="oneTimeCode"` on iOS. The code row stays LTR inside the Arabic UI, Arabic digits are normalized, and resend waits 60 s.
- **Email templates** (in `supabase/templates`, D-068): show only the code (`{{ .Token }}`, in its own table cell), no links. Body and subject are bilingual through a Go condition on `{{ .Data.locale }}` (`"en"` → English, else Arabic, RTL). `user_metadata.locale` is set at sign-up and kept in sync with `profiles.locale` by the language switch. Templates: confirmation (sign-up), magic_link (sign-in and "confirm it's you", neutral wording), recovery, email_change (one per address) and reauthentication (not used by the app). `[auth.rate_limit] email_sent = 100`/hour needs custom SMTP.
- **Email delivery:** Resend custom SMTP with SPF/DKIM/DMARC before any real user. Auth mail (e.g. `auth.mail.<domain>`) and notifications (e.g. `notify.<domain>`) use separate subdomains and preferably separate API keys. The API's own emails (invitations, Step 6) use the Resend HTTP API with `RESEND_API_KEY` and `EMAIL_FROM` on the notifications subdomain, so abuse of invitations cannot hurt Auth mail; locally they go to Mailpit (§API & request flow, Step 6).
- **Mobile session:** supabase-js with `LargeSecureStore`: an AES key in expo-secure-store (2 KB limit) and the encrypted session in AsyncStorage. `android.allowBackup: false`. If decryption fails, the app clears the session and treats the user as signed out. Auto-refresh starts and stops with AppState. `detectSessionInUrl: false`.
- **Profiles** are created by an upsert in the `me` procedure, not by a trigger on `auth.users` (display name = the email's local part until the user sets one; home then says "Welcome to BizCost" instead of greeting by it). `account.updateProfile` saves the name and/or language and copies a new name to the user's active memberships (`business_members.display_name`, D-065).
- **Web session** (D-069): `@supabase/ssr` cookies, `Secure` except on plain http to a host other than localhost (`secureSessionCookies`), `SameSite=Lax`. `proxy.ts` refreshes the session (keeping the refresh's cookies and no-store headers on redirects), sends signed-out visitors to `/login` and signed-in users away from the auth pages (`/reset` is open to both). A code request hands only the email, purpose, send time and a planned automatic resend (D-073) to `/verify` or `/reset` through sessionStorage (for `/reset` also whether the code was already used and whether a new password is required, so a reload never offers a password change).
- **Invitations** (D-082): our own `business_invitations` table, not `auth.admin.inviteUserByEmail` (DATA_MODEL.md §4 business_invitations).
  - Invite: email, a role (never the Owner role) and the email's language (default: the business language). The token is 32 random bytes in base64url; only its SHA-256 hex is stored. The link `{APP_URL}/invite/{token}` works for 7 days; "send again" makes a new token (the old link stops working). The email goes out after the commit; when it cannot be sent, a new invitation is revoked (nobody got its link) and the call fails, and a failed resend leaves the new link unsent.
  - Limits in the database (`app.invitation_limits`, SQLSTATE BZ429 → `rate_limited`): 20 invitations per business and 40 per inviting user in 24 hours, 3 resends per invitation, 4 emails per address and business in 24 hours (cancelling and inviting again does not start over). Every write is audited.
  - `invitation.preview` (public, `app.preview_invitation`, at most 30 per invitation an hour) returns only the business name, the inviter's name, the role (template key, and the role name for a custom role), the invited email masked (`r•••@example.com`), the expiry and, when signed in, whether the caller's verified email is the invited one. Any unknown, used, revoked or deleted-business token is the same `invitation_invalid`. Counting previews neither touches the invitation row nor writes the audit log.
  - `/invite/[token]` (open signed in or not): signed out, the visitor creates an account or signs in; the way back, the business name and the masked email stay in this tab's sessionStorage (never in a URL) and the sign in and sign up pages say which business and which email the invitation is for; after the code or password the page returns. Signed in with the invited email: "Accept the invitation" → `app.accept_invitation` → `/b/[businessId]` (also the last business). Signed in with another email: a clear message and "sign out and use the invited email". Accepting requires the invited, verified email, a live business and role, and a sender who is still an active member allowed to invite.
- **Invariants:** every business has at least one active owner, and ownership transfer is an explicit action.
- **Account deletion** (in-app, M1, an Apple requirement; as built: D-064): blocked (`sole_owner`) while the user is the sole owner of a business that has other members (transfer ownership or delete the business first). Checked before any change: the secret key, the sole-owner rule, the Auth admin API (`getUserById`), and a sign-in within `AUTH_RECENT_SIGN_IN_SECONDS` (600 s, newest `amr` entry; else `reauth_required` and the dialog asks for an emailed code). Then per business, in its own transaction: a business whose only member is the user is soft-deleted (row locked `FOR UPDATE`, plan re-checked), the invitations the user sent are revoked, and the membership becomes `removed` with display name 'Deleted user' and no email. Last, in one transaction: anonymize the profile (never hard-delete it), clear the email and name of every membership of the user, also ones removed earlier (`app.anonymize_my_memberships`), and `auth.admin.deleteUser`, so a failed Admin call changes nothing there. Idempotent, so a half-finished deletion is retried. Works because actor columns have no FK to `auth.users` (DATA_MODEL.md §1.3). A deleted account's token is refused by `openAccount` until it expires (D-065).
  - Business deletion and data export semantics: DATA_MODEL.md §4 (businesses). No UI for them in M1.
- **Staff PIN on a shared device** [Later]: the data model allows a member without an auth account from M1 (DATA_MODEL.md §4 business_members). The PIN login UI comes later (ROADMAP.md).
- [Later]: Send Email Hook, TOTP MFA, social login, phone OTP, biometric lock.

## Tenancy & security

### Active business

- On web the active business is in the URL (`/b/[businessId]`), so several tabs can each open a different business. On mobile it is persisted on the device.
- It is sent as `x-business-id`. The server checks active membership in the DB on every request, so a removed member is rejected on their next request.
- It is never a JWT claim (goes stale) and never a cookie (shared across tabs). `profiles.last_business_id` picks where to go after login: `/` sends a user with a business to it while they are still an active member, else to their first business; without one, home offers Smart Setup. `business.createFromSetup` sets it, and so does `account.setLastBusiness`, which the web calls when a business page opens (`RememberBusiness`); a business the caller is not an active member of is FORBIDDEN (D-077).
- A business link has one spelling: the business layout redirects an id in capitals to the lowercase form that `me`, the switcher and the API use.

### Database access

- Drizzle + postgres.js through the Supavisor transaction pooler (port 6543, `prepare: false`), logging in as `bizcost_api.<project_ref>`. Fallback: a dedicated pooler or a direct connection. To be proved in Step 0c.
- `bizcost_api`: no BYPASSRLS, not a superuser, does not own tables. It **fails closed**: a query without tenant context returns zero rows. Provisioning (NOLOGIN in migrations, default privileges, timeouts, per-environment password from a secret via §Runbooks): DATA_MODEL.md §1.1.
- Schema `app` is not exposed to the Data API (PostgREST), and `anon`/`authenticated` get zero grants on it.
- `withTenantTx(ctx, fn)` is the **only** data entry point. Its first statement sets `app.user_id`, `app.business_id` and `app.request_id` with `set_config(…, true)` (transaction-local); it rejects non-UUID inputs before touching the DB. Lint (`bizcost/no-raw-set`) bans raw `SET`/`RESET` and `set_config` everywhere else, and a test asserts the context is empty after each transaction.
- The transaction pooler supports no prepared statements, LISTEN or session locks. Design around this.

### RLS

- Every tenant table has ENABLE + FORCE RLS and one generated policy (FOR ALL, so it acts as USING and WITH CHECK):
  ```sql
  business_id = (select app.current_business_id())
  and (select app.is_active_member(app.current_business_id()))
  ```
  No row column is passed to a function, so Postgres evaluates it once per query as an InitPlan. pgTAP/EXPLAIN tests assert InitPlan and no SubPlan.
- Identity tables (`profiles`, `businesses`, `business_members`) have their own policies (DATA_MODEL.md §2). Creating a business and accepting an invitation go through narrow SECURITY DEFINER functions.
- Database triggers hold the rules no API path may skip: `app.audit_row()` writes `audit_log` for every write (the API role can only read it), `app.touch_row()` maintains `updated_*`/`version`, and a deferred constraint trigger keeps at least one active owner per live business (DATA_MODEL.md §1.2, §1.6, §4).
- RLS handles **tenant isolation only**. Roles, permissions, module gates and redaction live only in TypeScript, so no rule is written twice.
- A CI catalog check asserts that every table with `business_id` has FORCE RLS + the standard policy. The schema also enforces tenancy with composite FKs `(business_id, x_id)` (DATA_MODEL.md §1.2).

### SECURITY DEFINER functions

- Only in schema `app`, never `public` (which would expose them via `/rpc`). `SET search_path = ''` with fully qualified names. Explicit owner (`postgres`), which also stops RLS recursion on `business_members`.
- `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`, then `GRANT EXECUTE` to `bizcost_api` only. pgTAP `grants` checks no `app` function is executable by PUBLIC/anon/authenticated and every definer function has `search_path` in `proconfig`.

### Secrets & server-only code

- The service/secret key is server-only, used for exactly: Auth admin (account deletion) and Storage (signed URLs and checks of the business logo), both in `packages/api/src/admin`, which lint lets only the account and business-profile services import; background jobs [Later]. Sentry scrubs cost values. The AI layer [Later] only creates drafts a human confirms, and its output passes through redaction.
- **Telemetry (Step 2, D-058):** Sentry (`@sentry/nextjs`, server only, on only when `SENTRY_DSN` is set) collects no user info, cookies, bodies, query strings, DB query data or stack-frame variables (`dataCollection`). `beforeSend` drops request bodies, cookies and query strings, replaces any key like cost/profit/margin/price/salary/wage/payroll or a credential, and strips Drizzle's bound `params:` from error messages, causes included. Internal API errors are also logged with the request id and the same scrubbing (`apps/web/src/lib/report-error.ts`).

### Storage

- One private bucket `business-files` (created by a migration); paths `{business_id}/{entity}/{uuidv7}.{ext}`. It takes files up to 2 MB of type PNG, JPEG or WebP (no SVG: it can carry scripts). No Storage policy grants anything to `anon` or `authenticated`.
- Uploads and downloads use only signed URLs that the API issues after a permission check (D-085). Every upload URL is first registered in `app.file_uploads` (at most 10 per business an hour, in the database); a trigger on `storage.objects` (`app.guard_business_file`) lets Storage write an object of this bucket only at a path that is still `issued` and not expired, so an upload URL (Storage issues them for 2 hours) cannot write again once its file was saved, refused or removed. `business.setLogo` accepts only an open upload of this business, checks the object's size, stored type, extension and first bytes (else `file_invalid`, and the object is removed), and closes it; a replaced or removed logo's object is removed and its path closed. The profile returns a signed download URL that lasts 10 minutes (a URL stays valid after membership is revoked).
- Without background jobs, uploads that expired unused are removed when the business asks for its next upload URL [Later: a scheduled clean-up].

### Network exposure

- `*.supabase.co` was reportedly blocked in the UAE (Sep 2025, ~18 days) and in India (Feb–Mar 2026). So prod uses a Supabase custom domain (e.g. `auth.<domain>`) before the first store build; `EXPO_PUBLIC_SUPABASE_URL`, the web client and signed URLs all use it.
- CI fails if `supabase.co` appears in a web or mobile bundle. How this interacts with staging builds is open (ROADMAP.md §Open, with deadline).
- Option: proxy web auth calls through route handlers on `app.<domain>`. §Runbooks covers a region move or a blocking incident.
- Every web response sends `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`, and no `X-Powered-By` (`apps/web/next.config.ts`).

## Permissions, modules & capabilities

- Three independent server gates: **plan** (placeholder; only `businesses.plan` exists in M1) → **module enabled** → **permission**.
- **Capabilities** are business-level flags from Smart Setup (e.g. `has_team`, multi-location, `vat_registered`, `keeps_stock`, `uses_machines`). They hide fields, sections and pickers inside screens. `has_team` and `multi_location` are also API gates (D-080): the team, role and invitation procedures need `has_team` and the location procedures `multi_location` (CAPABILITY_DISABLED), and Customize BizCost refuses to turn them off while they are in use (other members or pending invitations: `team_in_use`; more than one location: `locations_in_use`). `vat_registered` is derived from `businesses.vat_registered` and edited in the business profile.
- The schema does not depend on capabilities, so turning one on needs no data migration. Product meaning: PRODUCT.md §5; storage: DATA_MODEL.md §4 business_capabilities.
- Middleware order: `authed → businessScoped → requireModule → requirePermission → handler → redact`.
- Permission keys look like `module.resource.action` and are declared in manifests. Role templates are copied per business as editable roles. Members can have allow/deny overrides and a location scope. Evaluation is pure (`resolveEffective`, `can`) in `domain`.
- M1 UI covers only templates, assigning a role and editing a role's permissions (ROADMAP.md). The Roles editor does not offer the sensitive-data keys (`data.*`, with the first module that has sensitive fields) nor, for a single-location business, "Manage branches"; a role keeps such keys as they are when saved (D-084).
- **Redaction:**
  - `.output()` is mandatory on every procedure (CI check). Zod objects strip unknown keys.
  - Sensitivity categories: `cost`, `profit_margin`, `supplier_price`, `payroll`, `employee_pii`. They are grouped so a hidden value cannot be derived from visible ones (e.g. price + margin reveals cost). Tags go in Zod v4 metadata.
  - The `redact` middleware reads the output-schema metadata automatically. A hidden field is removed and listed in `meta.redacted`, and the UI shows a lock instead of a misleading 0.
  - As built (D-057, D-060): the middleware takes the output schema of the procedure being served from the router. Before the handler runs it fails closed (INTERNAL) when the schema has sensitive fields outside a business procedure or without the `withMeta()` envelope, or when the redactor cannot check it; after output validation it removes the hidden fields. `sensitive()` may tag object fields only (also behind wrappers, pipes or `z.lazy()`; not array items, record or catchall values, union options, intersection sides, or fields under a transform or codec). Every output value must be typed: `z.unknown()`/`any()`/`custom()`, loose/passthrough objects, `.transform()` results, Map/Set/promise and unknown Zod types are rejected. These are schema errors that the contract test reports. `meta.redacted` lists dotted schema paths relative to `data`, with `*` for every array item, record value or `.catchall()` key (e.g. `lines.*.unitCost`), whether or not a value is present.
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
- Enabled (D-059, `resolveEnabledModules`): a core module is on unless its `business_modules` row switches it off; an optional module is on only through an enabled row; Dashboard and Settings are always on and their rows are ignored. Smart Setup writes `enabled = false` rows for the core modules a business does not use.
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
- As built (Steps 3 and 5): the web (app) layout loads `me` through the server caller and seeds it into a `QueryClient` created per mount (`ApiProvider`, `httpBatchLink` with `maxItems` = `API_MAX_BATCH_SIZE`). `b/[businessId]/layout.tsx` loads `me` and `business.context` (`getBusinessContext`: not a member or no such business → not found) and mounts `BusinessApiProvider` with `key={businessId}`: its own `QueryClient` and a tRPC client that sends `x-business-id` on every request, seeded with both, so no cached data or in-flight query crosses businesses (D-079). Sign-out reloads the page, which drops the cache.
- **Stale `me`/permissions:** invalidate `me` on any FORBIDDEN, refetch on window focus, and compare the `permissions_version` response header (from `business_members.permissions_version`) with the cached value.
- Web keeps filter and sort state in the URL (nuqs) and uses cursor pagination. Mobile wires `focusManager` to AppState and `onlineManager` to NetInfo.

## i18n & RTL

- i18next + react-i18next on both platforms. Files: `packages/i18n/locales/{en,ar}/<namespace>.json`: `common`, `auth`, `account`, `errors`, `setup`, `modules`, `settings` and `emails` (the API's own emails) today; `units`… arrive with their steps. Keys are written in full (`auth.login.title`) and typed via `CustomTypeOptions`. Arabic uses 6 plural forms. Tests fail when a key, plural form or interpolation variable differs between the languages, a message is empty, or an `errors.<code>` / mapped Supabase error key is missing.
- Locale order (D-067): web reads the `bz_locale` cookie → the first `ar*`/`en*` of Accept-Language → Arabic; for a signed-in user `profiles.locale` wins (the (app) layout writes it to the cookie when they differ, then renders again). Mobile: `profiles.locale` → expo-localization. No locale segments in URLs. Switching language saves the cookie, and when signed in also `profiles.locale` (API) and `user_metadata.locale` (auth emails).
- **Next server:** one i18next instance per request via `createInstance()` inside React `cache()`. Never a global `changeLanguage` on the server (lint rule). The root layout sets `<html lang dir>` from the request's locale, so there is no flash, and passes the locale to the client `I18nProvider`, which creates its own instance. Today the browser bundle holds every namespace of both languages; with `setup` and `modules` (Step 5) the messages chunk grew from about 24 to 36 KB gzip. Passing only the needed namespaces of one language is deferred to Step 7, which builds the app shell and its routes (D-069, D-079).
- **Terminology overlays** per profile (general, food, maker, workshop, factory, projects) replace **whole sentences**. Nouns are never interpolated into sentences. As built: an overlay is the key `<key>_<profile>` in the same namespace (e.g. `modules.materials.name_food`), and `terminologyKey(key, profile)` (`@bizcost/i18n`) picks it when it exists; the profile comes from `business.context.terminologyProfile` (the review uses the recommended one). Wording: PRODUCT.md §13.
- **Formatting:** Intl with `ar-AE-u-nu-latn` (Latin digits by default). Currency comes from the business.
- **Hermes (mandatory):** before i18next init, import `@formatjs/intl-getcanonicallocales`, `@formatjs/intl-locale/polyfill`, `@formatjs/intl-pluralrules/polyfill-force` and the ar/en locale data. Test Arabic plurals for 0, 1, 2, 3, 11 and 100, plus NumberFormat for `ar-AE-u-nu-latn` in AED.
- **RN RTL:** `supportsRTL` + `supportedLocales ['en','ar']`. Switching direction calls `I18nManager.allowRTL/forceRTL` then `Updates.reloadAsync()` behind a restart notice. Test in dev builds only.
- **Logical layout only:** lint bans physical classes (`ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`/`text-right`/`rounded-l|r`/`border-l|r`) and physical RN props (`marginLeft`…). Directional icons use `DirIcon`. Numbers, TRN and codes go in `<bdi>`/`dir="ltr"`. Amounts use `tabular-nums`.
- **shadcn:** set `rtl: true` in `components.json` **before** the first `shadcn add` (otherwise run `shadcn migrate rtl`). Add the Radix `DirectionProvider`. Review Sidebar, Calendar and Pagination by hand. Set the vaul direction and the sonner position manually.

## Styling

- `packages/tokens/src/tokens.ts` is the single source: semantic colors for light and dark (incl. `profit`, `loss`, `chart-1..6`), radii and fonts. It generates:
  - `theme.web.css`: Tailwind v4 `@theme inline` + `:root`/`.dark` variables for shadcn.
  - `theme.native.css`: Uniwind `@layer theme { :root { @variant light {…} @variant dark {…} } }`.
- A test (`pnpm check`) makes sure both files are up to date and define the same variables in both themes; regenerate with `pnpm --filter @bizcost/tokens generate`. Web imports `theme.web.css` in `app/globals.css`; fonts come from `next/font/google` (IBM Plex Sans + IBM Plex Sans Arabic; Arabic pages put the Arabic face first).
- Web tap targets are at least 44 px (buttons `h-11`, 36 px only on large screens with a mouse; small text links get a larger invisible tap area, the `tap-area` utility). Focus rings use the full `ring` color.
- Mobile uses only standard utilities inside the ~15 primitives, so moving to NativeWind v5 stays a small refactor. Icons have the same names in lucide-react and lucide-react-native.
- Dark tokens are defined now. Dark-mode polish comes [Later].

## Environments & deployment

| Env           | Where                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Local         | Supabase CLI + Docker Desktop (WSL2), Mailpit for codes. `supabase/seed.sql` sets the local-only API password |
| Staging, Prod | Supabase projects in ap-south-1 (there is no Middle East region, and the region cannot change later) + Vercel |

- **Supabase plans are per organization:** either two orgs (Free for dev/staging, Pro for prod) or both projects in one Pro org (~$35+/mo). Start on Free. Upgrade prod before the first real customer, because the custom domain and leaked-password protection need Pro. A Free staging project pauses when idle. PITR before the first paying customer. Open items: ROADMAP.md §Open, with deadline.
- **Config:** `supabase/config.toml` holds the OTP settings, the password rule (D-072), templates, rate limits and exposed schemas (without `app`). Apply it to hosted projects with `supabase config push`, never by hand in the dashboard.
- **Vercel Pro:** one project with functions pinned to `bom1` in `vercel.json` (the default is iad1). A smoke check verifies the region after deploy. Not dxb1: the DB is in Mumbai, and dxb1 is reportedly under maintenance.
- **Serverless pooling:** postgres.js `max: 1` + `idle_timeout`, and `attachDatabasePool` (@vercel/functions) with Fluid compute. Role-level `statement_timeout`. Step 2 ships `createDb()` only; `attachDatabasePool` and the pool size under Fluid concurrency are settled with the first deploy (ROADMAP.md Step 2).
- **EAS:** Build (iOS without a Mac), Submit and Update. Channels: development, preview, production. `runtimeVersion` policy `fingerprint`. Internal testing on TestFlight and the Play internal track.
- **Web environment** (validated on the first request by `apps/web/src/lib/env.ts`, so `next build` needs none; names in `.env.example`): `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`), `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL` (bizcost_api), `MIN_SUPPORTED_APP_VERSION` (default 0.0.0), `APP_ORIGINS` (required in production; dev default `http://localhost:3000,http://127.0.0.1:3000`), `SUPABASE_SECRET_KEY` (server only, for account deletion; required in production, optional locally where deleting an account then fails with a clear error). `SENTRY_DSN` (optional) is not part of it: only `instrumentation.ts` reads it, and an invalid value only turns Sentry off. `health.version` is the first 12 characters of `VERCEL_GIT_COMMIT_SHA` (`dev` locally).
- **Migrations:** Drizzle schema → `drizzle-kit generate` into `supabase/migrations`, applied **only via the Supabase CLI** (`db reset` locally, `db push` from `db-migrate.yml`, manual approval for prod). Never `db push --include-seed` or `db reset --linked`: the seed holds the local password. Layout and rules: DATA_MODEL.md §1.1.
- **Heavy work** [Later]: cost recomputation and reports need background jobs (pgmq, pg_cron or Vercel Cron) before those phases (ROADMAP.md).

### Local setup

- One-time, per machine: `pnpm auth:signing-key` creates `supabase/signing_keys.json` (an ES256 private key, gitignored; `config.toml` sets `[auth] signing_keys_path`) with `supabase gen signing-key --algorithm ES256`. Every Supabase CLI command loads `config.toml` and fails without the file (`start`, `status`, `db reset`, `test db`, `migration new`, `db push`), so run it right after cloning. The Auth server reads the key at start: after creating or rotating it, restart the stack (`pnpm exec supabase stop && pnpm exec supabase start`; data is kept). To rotate, delete the file and run the script again. CI writes a throwaway key the same way; `db-migrate.yml` (Step 9) must also create the file (an empty `[]` is enough) before `supabase db push`.
- Web: put the names from `.env.example` in `apps/web/.env.local`, with the local values from `pnpm exec supabase status -o env` (API_URL, PUBLISHABLE_KEY) and the local `DATABASE_URL`; then `pnpm --filter @bizcost/web dev`.
- Integration tests: `pnpm db:test` (pgTAP + `@bizcost/db`) and `pnpm api:test` (`@bizcost/api` through the fetch handler, with real users in the local Auth server; keys are read from `supabase status`). Both need the local stack; neither is part of `pnpm check`. `api:test` makes only two password sign-ins per run (the local limit is 30 per 5 minutes per IP); other tests mint tokens with the local signing key (`mintToken`), which `getClaims()` verifies exactly like real ones.
- End-to-end: `pnpm e2e` (D-070) builds `apps/web` into `.next/e2e` and starts it on `E2E_PORT` (default 3100) with the local stack's keys, then runs Playwright (Chromium; once per machine: `pnpm --filter @bizcost/e2e exec playwright install chromium`). Codes are read from Mailpit. Run it after `pnpm db:reset`; if something already listens on the port, set another `E2E_PORT`.

### Runbooks (written in Step 9 as subsections here)

- Set or rotate the `bizcost_api` password per environment, and rotate keys.
- Migrations and restore.
- Region move (e.g. to Frankfurt) and a communication plan for a `*.supabase.co` block.

## Testing & CI

GitHub Actions: `ci.yml` (every PR) and `db-migrate.yml` (applies migrations; manual approval for prod).

| Check                         | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck, lint               | Package boundaries and layer order, one DB entry in the API, server-only, no float money, no raw SET, no server `changeLanguage`, logical RTL classes/props. Next's generated route types (`.next/types`) are type-checked by `next build` and, once generated, by typecheck                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Vitest (+ fast-check)         | `domain`: decimals, rounding, permission engine (units from M2). `modules`: Smart Setup questions and skip logic, `recommend()` for the 8 personas and edge cases of PRODUCT.md §6.11, fast-check invariants of §6.10 over every valid answer walk, review adjustments and review data. `apps/web`: wizard flow and landing rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| pgTAP                         | RLS isolation (`rls_*`, 2 businesses × 2 users), `grants` (SECURITY DEFINER rules, `audit_log` read-only), `catalog_coverage`, InitPlan in EXPLAIN, invariants, account deletion path; Step 6: the bucket, invitation limits, preview and accept rules, the upload registry and Storage guard, membership anonymization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Migration drift               | Drizzle schema vs `supabase/migrations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DB integration (`db` CI job)  | `pnpm auth:signing-key`, `supabase start -x …` (Postgres, Auth, API gateway, Mailpit), pgTAP, `@bizcost/db` Vitest as `bizcost_api` (tenancy, owner-rule races), the `@bizcost/api` integration tests, then Playwright e2e. Locally: `pnpm db:reset && pnpm db:test && pnpm api:test && pnpm e2e`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Contract checks               | `.output()`, redact placement and a fully typed output on every procedure (`packages/api` unit test); redaction for every starter role template against a hand-written oracle, and FORBIDDEN on a sensitive sort (API integration tests); Step 9 extends the oracle to every procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Static checks                 | Missing Arabic keys, token parity (web/native), no `supabase.co` in bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Playwright                    | Step 3: sign-up (and the password rule: checklist, page and Auth refusal, LTR ranges in Arabic), sign-in (password and code), reset, language switch (AR↔EN, RTL password field), account (name, password, email, deletion with and without a recent sign-in, sign-out here/everywhere) and the security regressions (same Auth answers, Secure cookies, no framing). Step 5: sign-up → Smart Setup → ready → business home, a reload mid-wizard, a second business through the switcher and back (EN and AR), a retried Confirm, a business link in capitals. Step 6: a solo business sees only its sections, profile with VAT and TRN, logo, Customize BizCost with its warnings and guards, business language, Arabic; invite → email in Mailpit → a new user joins, the invitation page in Arabic, a role change changes access, ownership transfer after "confirm it's you", a removed member refused next, joining a long-named business on a phone and leaving it. Step 9 adds AR/EN smoke at 375/768/1440 px |
| Cross-tenant attacks          | 2 businesses × 2 users through the API, PostgREST with a real JWT, and Storage paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Mobile (Expo spike + devices) | Arabic plurals, Intl on Hermes, golden rounding web vs Hermes, RTL restart, LargeSecureStore failure path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Key risks

| Risk                                                                       | Mitigation                                                                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `*.supabase.co` blocked in the UAE/India                                   | Custom domain, bundle check, region-move runbook                                                                     |
| Functions drift to iad1                                                    | `vercel.json` bom1 + region smoke check                                                                              |
| Tenant context leaks across pooled connections; data exposed via PostgREST | `withTenantTx` + `set_config(…, true)` + empty-context test; `app` not exposed, zero grants, PostgREST attack test   |
| RLS slow on large ledgers                                                  | InitPlan policy, indexes starting with `business_id`, EXPLAIN on a big seeded business                               |
| Hidden values inferred (derived fields, aggregates, filters, telemetry)    | Mandatory `.output()`, automatic redact, FORBIDDEN on sensitive filters, scrubbing                                   |
| Access token stays valid after global sign-out or account deletion         | Membership check per request; deleted (anonymized) accounts refused (`openAccount`); consider a shorter JWT lifetime |
| Metro + pnpm on Windows                                                    | Hoisted linker, single React, to be proved in the Expo spike (Step 4)                                                |
| RN RTL bugs, Hermes Intl gaps                                              | Restart flow, FormatJS polyfills, real-device tests                                                                  |
| Uniwind is young                                                           | Standard utilities, ~15 primitives; NativeWind v5 fallback                                                           |
| OTP email deliverability to UAE corporate mail                             | Resend SMTP, SPF/DKIM/DMARC, separate subdomains, bounce monitoring                                                  |
| Solo founder building two UIs                                              | Shared logic packages, mobile limited to quick entry and dashboards                                                  |
| App Store review                                                           | In-app account deletion, reviewer demo account, purchase-link rules (3.1) once billing exists                        |
| Vendor lock-in; Windows dev env                                            | See §Overview exit paths; WSL2 memory, `eol=lf`, long paths, EAS free-tier queues                                    |
