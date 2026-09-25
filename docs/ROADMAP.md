# BizCost Roadmap

Purpose: phases, milestone scope, step status, owner actions and deadline-bound open decisions. Other docs cover the rest: product scope (PRODUCT.md), technical design (ARCHITECTURE.md), tables (DATA_MODEL.md) and rationale (DECISIONS.md).

Last updated: 2026-09-25

Status legend: `DONE` · `IN PROGRESS` · `NEXT` · `PLANNED` · `BLOCKED (reason)`

## How we work

- One milestone at a time. The owner approves each milestone's scope ("Proceed") before work starts.
- Do not build future phases early. Before their phase there is no cost engine, unit/inventory/waste calculation, AI, POS API, payroll, full VAT or advanced reporting. Do not create empty stub files for them either (e.g. no WAC file in M1).
- No placeholder screens. Each module manifest has `availability: 'released' | 'planned'`, and nav, tabs and "+" show only the released modules the business has enabled (ARCHITECTURE.md §Modules).
- Web leads. Mobile gets a flow only when its module ships.
- When a step completes: tick it here, update its status and "Last updated". Record new or changed decisions in DECISIONS.md, not here.
- Ask the owner only when a missing decision would cause significant rework.

## Phase overview

| #   | Phase          | Goal                                                                  | Main contents                                                                                                                                                                                        | Status           |
| --- | -------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Foundation     | Secure multi-business, multi-user base: web plus a minimal mobile app | Auth (email + password, 6-digit email codes), businesses, locations, members, roles/permissions, Smart Setup (modules + capabilities), settings, responsive shell, EN/AR + RTL                       | IN PROGRESS (M1) |
| 2   | Costing Core   | Know what each product really costs                                   | Products & Services, Materials, unit conversion, Suppliers, Purchases, weighted average cost (WAC), recipes/product cost, Expenses, Running Costs, basic cost engine                                 | PLANNED          |
| 3   | Sales & Profit | See real profit                                                       | Sales entry, Orders (delivery per order), CSV/Excel import, cost engine applied to sales, profit dashboard, **Quotations & Invoices** (UAE tax invoices, e-invoicing through an accredited provider) | PLANNED          |
| 4   | Control        | Find where money is lost                                              | Stock, stock counts, expected vs actual usage, Usage & Waste Monitor, variance alerts                                                                                                                | PLANNED          |
| 5   | Operations     | Put labor, machines and jobs into the cost                            | Employees, attendance, equipment (machine cost/hour), projects, jobs & tasks, vehicles, petty cash, VAT Center, documents; staff PIN login on a shared device (unless built earlier)                 | PLANNED          |
| 6   | Intelligence   | Automate and explain                                                  | AI invoice capture, "why did my profit drop?", advanced analytics, POS/API integrations                                                                                                              | PLANNED          |

- Quotations & Invoices moved up to Phase 3 (from "documents" in the owner's draft Phase 5) because invoicing is required; the owner did not object (2026-09-24, D-005).
- The owner roadmap does not yet place some modules (Customers, Payments, Payroll, Jobs & Tasks). PRODUCT.md §7 marks their tentative phase; each is confirmed when that phase is planned.

## Milestone 1 = Phase 1 Foundation

Estimate: **~9–11 weeks solo**. Step 0 is IN PROGRESS (0a and local 0b done). Step 1 is DONE. Step 2 code is DONE; its Vercel deploy is BLOCKED on owner accounts. Step 3 is DONE (local; hosted settings follow the Step 0b/2 deploy). All other steps are PLANNED.

- [ ] **Step 0: Repo & environments** (IN PROGRESS)
  - [x] 0a Scaffold (DONE 2026-09-24; first code: `domain` digit normalization + TRN parsing, custom RTL lint rules with tests). git init, `.gitattributes` eol=lf, pnpm workspaces (hoisted, catalogs) + Turborepo, TS strict, ESLint (package boundaries, RTL logical classes only, no float for money), Vitest, CI, CLAUDE.md, the 5 docs, mockups moved to `docs/mockups`.
  - [ ] 0b Environments. Local: DONE 2026-09-25 (Docker Desktop + Supabase CLI 2.117 local stack running; `config.toml` auth settings; bilingual email templates are done in Step 3). Hosted: BLOCKED (owner accounts). Docker Desktop + Supabase CLI local stack with Mailpit. `config.toml` sets otp_length=6, otp_expiry=600, bilingual code-only templates and keeps `app` unexposed; it is applied to hosted projects with `supabase config push`. Staging and prod projects in ap-south-1 with asymmetric JWT keys and Resend SMTP. Vercel project pinned to bom1.
  - [ ] 0c Prove that login as `bizcost_api.<ref>` works through the pooler (fallback: dedicated pooler or a direct connection).
- [x] **Step 1: Data foundation** (DONE 2026-09-25; decisions D-047–D-053). `app` schema (not exposed); `bizcost_api` role (NOLOGIN in migrations, password set per environment from a secret); SECURITY DEFINER context/membership functions; `tenantTable()`, `withTenantTx()`. Identity/tenancy tables, membership without an auth account (for staff PIN later), invite rate-limit counters, append-only `audit_log`. pgTAP tests: isolation, grants, catalog coverage, RLS EXPLAIN shows InitPlan. Details: DATA_MODEL.md. Built: `packages/db` (schema, `withTenantTx`, `createDb`), 4 migrations, DB triggers (audit, touch/version, at least one owner), pgTAP + Vitest integration/attack tests, CI `db` job, `bizcost/no-raw-set` lint rule.
- [ ] **Step 2: API core** (code DONE 2026-09-25; deploy BLOCKED; decisions D-054–D-061). Scope: tRPC in `packages/api`, mounted in the web route; `getClaims` context; public/authed/business procedures. Full permission engine in domain with tests (templates, overrides, location scope, sensitivity). `requireModule`; mandatory `.output()` + automatic redact middleware; audit with request_id; typed errors → i18n keys; app-version gate; idempotent creates; Sentry; `health` + `me`. Deploy to Vercel bom1 with a region smoke test.
  - [x] Code (DONE 2026-09-25): `packages/contracts`, `packages/modules`, the permission engine in `domain`, `packages/api` (fetch handler with a batch limit, context with a caller-bound `tenantTx`, bases, gates, fail-closed redaction, error mapping, `health`/`me`/`business.context`), `insertIdempotent` in `packages/db`, `apps/web` as the API host (route handler, env validation, Sentry scrubbing, `vercel.json` bom1), a local ES256 signing key, lint for the layer order and the API's DB entry, unit + contract tests in `pnpm check`, API integration tests (`pnpm api:test`, incl. a redaction oracle for every role template) in the CI `db` job.
  - [ ] Deploy (BLOCKED: owner accounts). The owner imports the repo in Vercel Pro (root directory `apps/web`; `vercel.json` pins bom1) and sets, for Production and Preview: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL` (the `bizcost_api.<ref>` pooler URL, port 6543, after Step 0c), `APP_ORIGINS` (e.g. `https://app.<domain>`), `MIN_SUPPORTED_APP_VERSION` (`0.0.0` until the first store build) and, optionally, `SENTRY_DSN` (Sentry project, server only). Then: `health` must report `region: "bom1"` (smoke test), add `attachDatabasePool` (@vercel/functions, pinned in the catalog; confirm postgres.js support) and settle the pool size under Fluid compute.
- [x] **Step 3: Web auth** (DONE 2026-09-25; decisions D-062–D-070). Sign up with an email code. Sign in with password or code; the screens never reveal whether an account exists (Supabase's remaining API-level signals are listed in D-062). Reset by code, sign-out here or everywhere. Profile (name, language), change password (emailed code checked by Supabase), secure email change, delete account (sole-owner guard, recent sign-in). Built: `packages/tokens`, `packages/i18n`, `packages/app-core` (auth flows, form schemas, tRPC/Query), `apps/web` auth + home + account pages (AR/EN, RTL, 375–1440 px), `account.updateProfile`/`account.delete` in `packages/api`, bilingual code-only email templates, Playwright e2e (`pnpm e2e`, also in the CI `db` job). Before the first real user: Resend SMTP (owner action) and CAPTCHA on sign-up, code and reset (Cloudflare Turnstile, owner action); when the Supabase CLI supports them, "require the current password" and the "password changed" email (D-063).
- [ ] **Step 4: Expo spike (2–3 days).** SDK 57 dev build, Android first, iOS once Apple approves the account. Prove: Metro + pnpm hoisted, Uniwind + native theme, LargeSecureStore (allowBackup false; a decrypt failure signs the user out), code login, `me` via Bearer to bom1, httpBatchLink, FormatJS Intl polyfills (Arabic plurals 0/1/2/3/11/100), switching to RTL with a restart.
- [ ] **Step 5: Businesses & Smart Setup.** Create a business; switch businesses via `/b/[businessId]`. Versioned adaptive questions with skip logic. A pure `recommend()`, tested for each industry, suggests modules and capabilities; a review screen gives the reason for each in plain words. Confirming the review enables the modules, sets capabilities and the terminology profile, and creates the default location and roles. See PRODUCT.md §Smart Setup.
- [ ] **Step 6: Web settings.** Business profile (logo via a signed URL, 15-digit TRN check, VAT status), locations, members and invitations (invite, resend, revoke, accept, change role, remove, transfer ownership; rate-limited). Roles UI covers only role templates, assigning a role and editing role permissions. Customize BizCost (modules + capabilities, dependency warnings; disabling hides, never deletes). Language.
- [ ] **Step 7: Responsive web shell.** Desktop: sidebar built from the module registry and permissions (released modules only), topbar with the business switcher, language and user. Tablet: collapsed sidebar. Below 768px: bottom nav with released modules only. Dashboard = real setup checklist (complete profile, add TRN, invite a member, add a location). 403, disabled-module and empty states; skeletons; full Arabic/RTL pass.
- [ ] **Step 8: Minimal mobile app.** Code auth, business switcher, Home (setup checklist) + More (profile, language with RTL restart, sign out, delete account). No Sales/Costs tabs and no "+" until M2. `supportsTablet:false`. The Supabase custom domain must be live before the first store build. EAS preview → TestFlight internal + Play internal track.
- [ ] **Step 9: Hardening & docs.** Cross-tenant attack tests (2 businesses × 2 users) through the API, PostgREST with a real JWT, and Storage paths. Redaction oracle test for each role template, over every procedure (Step 2 has it for a test procedure). `db-migrate.yml` must create `supabase/signing_keys.json` (an empty `[]` is enough) before `supabase db push`, because every Supabase CLI command loads it. Playwright smoke tests in AR and EN. CI check: no "supabase.co" in any bundle. Staging deploy; seed businesses for each industry. Update the 5 docs and runbooks (migrations, key/password rotation, restore, region move/blocking incident).

### M1 out of scope

- All data and cost modules (Materials, Products, Purchases, Sales, Expenses, Running Costs, Payments, Stock, Usage & Waste…) and any stub files for them.
- Unit engine, cost engine, reports and charts. The unit engine in domain is a candidate first task for M2.
- Per-member permission override UI and the sensitive-fields section. They ship with the first module that has sensitive fields.
- On mobile: feature screens, Smart Setup, invitations and role management (web only in M1).
- Native tablet layouts and native iPad support.
- Offline mode and a persisted query cache.
- AI capture, POS/CSV import, public REST API.
- Phone OTP, TOTP MFA, Google/Apple sign-in, and the staff PIN login UI (M1 builds only the tables).
- Send Email Hook (per-user-language auth emails).
- Billing/subscriptions. M1 has only the `businesses.plan` column.
- Background jobs/outbox, idempotency keys for updates, general rate limiting (only the invitation counters are in M1), audit log viewer.
- Gapless numbering, multi-currency/FX, tax invoices, VAT Center.
- UI for business deletion and data export. M1 only documents their semantics.
- Command palette, saved table views, dark-mode polish, visual snapshot tests.

### M1 definition of done

- pgTAP isolation, grants and catalog-coverage tests pass. RLS plans show InitPlan, not SubPlan.
- The Employee (staff) role template receives no field tagged sensitive. Filtering, sorting, searching or exporting on a sensitive field returns FORBIDDEN.
- A removed member is rejected on their next request. Stale `me`/permissions refresh after FORBIDDEN.
- No cache leak when switching businesses or when two businesses are open in two tabs.
- Every write is in `audit_log` with actor and request_id.
- Every M1 screen works in Arabic RTL and English LTR at 375, 768 and 1440 px. Arabic (including plurals) is checked on real iOS and Android devices.
- Nav, tabs and the dashboard show no placeholder modules.
- Account deletion works end to end, including the sole-owner guard.
- An EAS TestFlight build (no Mac needed) signs in with a code against staging. Store builds use the custom domain, and the CI "no supabase.co" check passes.

## Owner actions (Claude never creates accounts)

| Action                      | Needed by            | Notes                                                                                                                                                     |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer ($99/yr)    | Start now; Steps 4/8 | Approval takes days                                                                                                                                       |
| Google Play Console ($25)   | Start now; Steps 4/8 |                                                                                                                                                           |
| Expo account (EAS)          | Step 4               | Cloud iOS builds, no Mac                                                                                                                                  |
| Domain                      | Step 0               | app., auth. (Supabase custom domain), separate mail subdomains for auth and notifications                                                                 |
| GitHub (repo + Actions)     | Step 0               | Account created (2026-09-25)                                                                                                                              |
| Vercel Pro                  | Step 2               | Functions pinned to bom1                                                                                                                                  |
| Supabase orgs/plans         | Step 0               | Start on Free; prod → Pro before the first real customer; custom domain before the first store build. Options: ARCHITECTURE.md §Environments & deployment |
| Resend + DNS SPF/DKIM/DMARC | Before any real user | Auth mail and notifications on separate subdomains; `email_sent = 100`/hour in config.toml needs it                                                       |
| Cloudflare Turnstile keys   | Before any real user | CAPTCHA on sign-up, email code and password reset (D-062)                                                                                                 |
| Sentry                      | Step 2               | Cost values are redacted in telemetry                                                                                                                     |
| Docker Desktop (WSL2)       | Step 0               | DONE (2026-09-25): the local stack runs on it                                                                                                             |

## Decisions

Settled decisions live in DECISIONS.md (e.g. D-005 invoicing, D-006 one WAC per business, D-007 no offline, D-008 staff PIN, D-042 iPad).

### Open, with deadline

| Decision                                                                                                                                                                              | Settle by                                        | Notes                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase org layout                                                                                                                                                                   | Step 0                                           | A Free-org staging project cannot have a custom domain, which conflicts with the "no supabase.co" check for staging builds. Resolve both together. |
| Wording of the Smart Setup questions (the app tone is simple MSA, D-067; the owner's example uses Gulf wording)                                                                       | Step 5                                           | PRODUCT.md §13                                                                                                                                     |
| Contacts model: unified `parties` vs separate customer/supplier tables                                                                                                                | Before Phase 2                                   |                                                                                                                                                    |
| Bilingual name columns convention (e.g. `name_ar`)                                                                                                                                    | Before Phase 2                                   | Columns are added with their tables                                                                                                                |
| Costing policy record: WAC in posting order, append-only stock ledger + balance projection, fixed-order row locks, reversal entries, period close date, per-location stock quantities | Before Phase 2                                   | One WAC per business is already settled (D-006)                                                                                                    |
| Running-cost allocation method                                                                                                                                                        | Before Phase 2 cost engine                       | DATA_MODEL.md §6                                                                                                                                   |
| Background jobs/outbox (pgmq, pg_cron or Vercel Cron)                                                                                                                                 | Before heavy cost engine/report work (Phase 2–3) | Serverless time limits                                                                                                                             |
| E-invoicing provider + re-verification of requirements (Peppol PINT-AE)                                                                                                               | Before building Invoices (Phase 3)               | Reported dates: PRODUCT.md §11                                                                                                                     |
| PDF engine with correct Arabic; gapless numbering design                                                                                                                              | Before Invoices (Phase 3)                        |                                                                                                                                                    |
| Payroll/advances/deductions placement; Projects vs Jobs & Tasks structure                                                                                                             | Phase 5 planning                                 | Not in the owner roadmap yet                                                                                                                       |
| VAT Center scope ("VAT Preparation & Review")                                                                                                                                         | Phase 5                                          |                                                                                                                                                    |

### Later (no fixed phase)

- Billing/subscriptions, including app store purchase rules.
- POS integrations, public REST API, outbound webhooks.
- AI layer. It creates drafts that a human confirms, and its output passes through redaction.
- Native tablet layouts and native iPad support.
- Multi-currency/FX. Financial documents carry a `currency` column from the start.
- Phone OTP (needs a UAE sender ID), TOTP MFA, social login, biometric app lock.
- Realtime/push, charts library, pg_trgm search, partitioning.
- Upgrades: NativeWind v5 (when stable, only if Uniwind fails us), Drizzle 1.0 (when stable), Expo SDK 58 (2–4 weeks after it is stable; re-test iOS `supportsRTL` first).
