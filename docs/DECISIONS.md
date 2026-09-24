# BizCost: Decision Log

Purpose: a numbered record of every confirmed decision, why we made it, and what we rejected. The details live in the doc each entry links to.
Last updated: 2026-09-24

- **Status:** every entry is DECIDED. Nothing is implemented yet beyond the Step 0a repo scaffold. "Open:" marks a sub-choice that is still unsettled, tracked in ROADMAP.md §Open, with deadline.
- **Editing:** append new entries with the next number and never renumber. To change a decision, add a new entry and mark the old one "Superseded by D-0xx".
- **Sources:** the owner's spec, the owner's confirmations (2026-09-24), and the architecture panel as corrected by its critique.

## Product

### D-001 · 2026-09-24 · One app that adapts through Modules and Capabilities

- **Decision:** One app serves every business type. The business type only picks a recommended setup; it is never a permanent limit. Adaptation has two layers: **Modules** turn whole sections on or off. **Capabilities** are business-level flags from Smart Setup (e.g. has_team, multi_location, vat_registered, keeps_stock, uses_machines, sells_via_pos) that hide fields, pickers and options inside screens. Setup questions branch with skip logic. The owner changes both later in Settings → Customize BizCost, with no data migration. Disabling a module hides its data but never deletes it. Workshops get a "Jobs & Tasks" capability for cost and profit per job, not a project-management app.
- **Why:** This is the owner's strongest rule: the UI shows only what a business uses, for everyone from a solo home business to a multi-job workshop.
- **Rejected:** separate apps or editions per industry; modules alone (too coarse); screens hard-coded around one industry. Details: PRODUCT.md §5 Adaptive product model, §6 Smart Setup

### D-002 · 2026-09-24 · One master record per real-world thing

- **Decision:** Each customer, supplier, material, product/service, employee and piece of equipment is entered once and reused everywhere. Edits made inside a document never change the master record. Material cost comes from purchase and inventory valuation, never from a price typed into a recipe.
- **Why:** This is the owner's single-source-of-truth rule. It stops modules from drifting apart.
- **Rejected:** copies of records inside projects or documents. Details: PRODUCT.md §4 Core product rules

### D-003 · 2026-09-24 · No placeholder screens; only released modules are shown

- **Decision:** Each module manifest has `availability: 'released' | 'planned'`. The nav, tabs and "+" show only released modules that the business has enabled. M1 releases only Dashboard and Settings. The M1 Dashboard is a real setup checklist built from real data (business profile, TRN, invite a member, add a location). Mobile M1 has only Home and More: no Sales or Costs tabs and no "+" until the first module ships in M2. No empty stub files (e.g. WAC, cost engine).
- **Why:** The owner's rule forbids placeholder screens, and empty screens mislead users.
- **Rejected:** guarded placeholder pages, empty dashboard cards and tabs with no module behind them (all from the draft architecture). Details: PRODUCT.md §5; ARCHITECTURE.md §Modules; ROADMAP.md §Milestone 1

### D-004 · 2026-09-24 · Keep the customer's existing POS

- **Decision:** BizCost never forces a business to replace its POS. Sales come in by manual entry, Excel/CSV import, or later a POS/API integration, and all of them feed one internal sales model. Daily totals per product are enough for costing. The Orders module serves businesses that have no POS.
- **Why:** The positioning is "keep the systems you already use".
- **Rejected:** BizCost as a POS replacement. Details: PRODUCT.md §4 Core product rules

### D-005 · 2026-09-24 · Real UAE tax invoices; e-invoicing through an accredited provider

- **Decision:** The Invoices module will issue UAE-compliant tax invoices (TRN, gapless sequential numbering, Arabic text). For mandatory UAE e-invoicing (Peppol PINT-AE; reported dates in PRODUCT.md §11), BizCost will integrate with an Accredited Service Provider (ASP); it will not become one. Quotations & Invoices move up to Phase 3 with Sales & Orders (proposed; the owner did not object).
- **Why:** The owner requires real invoices, and becoming an ASP is out of scope.
- **Rejected:** internal, non-tax documents only; becoming an ASP.
- **Open:** re-verify the rules and dates before building Invoices. Also open: ASP choice, the gapless numbering design, and a PDF engine that renders Arabic. Details: PRODUCT.md §11; ROADMAP.md §Open, with deadline

### D-006 · 2026-09-24 · One weighted-average cost (WAC) per material per business

- **Decision:** Each material has one WAC for the whole business, not one per location. Every purchase updates it, and recipes use it automatically.
- **Why:** The owner chose this. It keeps the stock ledger, row locking and the cost engine simple.
- **Rejected:** a WAC per location.
- **Open:** the full costing policy must be written before Phase 2: perpetual WAC in posting order, locking order, period close, per-location stock quantities. Details: DATA_MODEL.md §1.6, §6

### D-007 · 2026-09-24 · No offline mode

- **Decision:** Offline use is not required. There is no sync engine and no persisted query cache. The groundwork still allows adding offline later (D-031).
- **Why:** The owner confirmed it. Offline support would add a lot of complexity and would leave cost data stored on devices.
- **Rejected:** PowerSync, or SQLite with an outbox. Details: ARCHITECTURE.md §Data fetching & caching

### D-008 · 2026-09-24 · Staff without email log in with a PIN (option B)

- **Decision:** A business member can exist without an auth account. M1 designs the membership and auth tables for this. The PIN login UI, used on a shared branch device, is built later.
- **Why:** Many café and bakery staff have no email, and reshaping the membership tables later would be costly.
- **Rejected:** requiring an email login for every member. Details: DATA_MODEL.md §3, §4 business_members

### D-009 · 2026-09-24 · Bilingual, plain-language UI

- **Decision:** English and Arabic from day one, with both LTR and RTL. All labels, validation and messages are translated. The UI uses simple English with no accounting jargon ("Running Costs", not "Overhead Allocation"). Wording adapts to the business profile (e.g. "Recipe" vs "Materials / Product Cost").
- **Why:** This is the owner's spec; many users have limited English.
- **Rejected:** English first with Arabic added later. Details: PRODUCT.md §13 UI language & terminology

### D-010 · 2026-09-24 · Docs and code in English; the owner converses in Arabic

- **Decision:** Repo docs, code and identifiers are in English. Conversations with the owner are in Arabic.
- **Why:** The owner chose this; English docs are stable context for tools and future contributors.
- **Rejected:** Arabic repo docs. Details: D-045

## Platform & stack

### D-011 · 2026-09-24 · Next.js for the web + Expo for iOS and Android

- **Decision:** Next.js (App Router) serves desktop, tablet and mobile browsers. Expo builds the native iOS and Android apps. Versions at decision time: Next 16.3.x, Expo SDK 57 (React 19.2), tRPC v11, TanStack Query v5, Zod v4, Node 24 LTS.
- **Why:** Desktop needs purpose-built dense layouts (sidebar, tables, split views), while phones need a native feel. The owner confirmed this choice.
- **Rejected:** Expo-universal only (the owner rejected it); react-native-web inside Next; Solito; Tamagui. Details: ARCHITECTURE.md §Overview

### D-012 · 2026-09-24 · Share logic, not UI

- **Decision:** Shared packages: `domain`, `contracts`, `modules`, `i18n`, `tokens`, `app-core` (hooks, the tRPC/Query factory, auth state machines). Screens, layouts and navigation are per platform. Lint bans react-dom and react-native in shared packages, and bans React itself in domain, contracts, modules and i18n. Mobile covers quick entry and short dashboards; in M1 role management, module customization, Smart Setup and invitations are web-only.
- **Why:** A single UI layer would weaken both platforms and complicate SSR and RTL. About 60–70% of the non-visual code is still shared.
- **Rejected:** a shared JSX component layer. Details: ARCHITECTURE.md §Repo structure

### D-013 · 2026-09-24 · Supabase for Auth, Postgres and Storage

- **Decision:** Supabase provides Auth, Postgres and Storage. Clients use supabase-js for auth only; all data goes through our API (D-015). There are two hosted projects, staging and prod. Local dev runs on the Supabase CLI + Docker (WSL2) with Mailpit, with a hosted dev project as the fallback.
- **Why:** It is managed, it is standard Postgres (so we can leave later), and it supports email OTP natively.
- **Rejected:** Edge Functions as the API (Deno clashes with pnpm, Drizzle and Vitest); PostgREST/RPC as the main API.
- **Open:** org layout (plans are per organization). Build on Free; move prod to Pro before the first real customer (custom domain, leaked-password protection). Details: ARCHITECTURE.md §Environments & deployment

### D-014 · 2026-09-24 · Region: Mumbai; no data-residency requirement

- **Decision:** Supabase runs in ap-south-1 (Mumbai) and Vercel functions are pinned to bom1 (Mumbai). A Supabase project's region cannot be changed after it is created.
- **Why:** The UAE has no residency requirement for us and Supabase has no Middle East region. Mumbai gives the lowest latency from the UAE, with compute next to the DB.
- **Rejected:** Vercel dxb1 (the DB is in Mumbai, and dxb1 was reported under maintenance); Frankfurt; Singapore. Note: the UAE PDPL may matter to large clients; get legal advice before enterprise deals. Details: ARCHITECTURE.md §Environments & deployment

### D-015 · 2026-09-24 · tRPC v11 in a Next.js route handler, in one Vercel project

- **Decision:** The router lives in `packages/api` (fetch Request/Response only) and is mounted at `apps/web/app/api/trpc/[trpc]/route.ts`. It deploys as one Vercel project with `regions: ["bom1"]` and a smoke test that checks the region. The web client uses same-origin cookies plus an Origin check on writes. Expo sends a Bearer token plus `x-business-id` and `x-app-version`. RSC calls go through `createCaller`. No Server Actions for data. Links: web uses httpBatchStreamLink/httpBatchLink; mobile uses httpBatchLink (or expo/fetch for streaming).
- **Why:** One deploy and no CORS suits a solo founder. The default region iad1 would add latency to every query. Moving to a standalone Hono service would take about a day if Vercel limits ever bite.
- **Rejected:** a separate API service or second Vercel project now; Server Actions as a second write path. Details: ARCHITECTURE.md §API & request flow

### D-016 · 2026-09-24 · API changes must not break installed apps

- **Decision:** tRPC serves our own apps only. API changes are additive, with a grace period before anything is removed. `x-app-version` is checked against `minSupportedVersion`, and older apps get a forced-update screen. EAS Update uses the runtime fingerprint. A public REST `/v1` (OpenAPI generated from the same Zod schemas) comes later.
- **Why:** Installed store apps lag behind server deploys, and tRPC has no versioning.
- **Rejected:** breaking changes; exposing tRPC to third parties. Details: ARCHITECTURE.md §API & request flow

### D-017 · 2026-09-24 · Drizzle schema, applied by Supabase CLI migrations

- **Decision:** The Drizzle schema (stable 0.45.x) is the source of truth. `drizzle-kit generate` with the supabase prefix writes to `supabase/migrations`. Hand-written SQL (roles, functions, grants, triggers) goes in with `--custom`. Migrations are applied only by the Supabase CLI: `db reset` locally, `db push` from CI, with manual approval for prod. `supabase config push` applies config.toml to the hosted projects.
- **Why:** One migration history, reviewable SQL, and no config drift between environments (e.g. otp_length).
- **Rejected:** drizzle-kit push/migrate on shared DBs; Drizzle 1.0 beta; Supabase branching (for now); editing settings by hand in the dashboard. Details: DATA_MODEL.md §1.1; ARCHITECTURE.md §Environments & deployment

### D-018 · 2026-09-24 · Styling: Tailwind v4 + shadcn on the web, Uniwind on mobile

- **Decision:** `packages/tokens/src/tokens.ts` generates two files. `theme.web.css` uses Tailwind v4 `@theme inline` plus `:root`/`.dark` for shadcn. `theme.native.css` uses Uniwind's `@layer theme` with `@variant light/dark`. A check ensures every variable exists in both. Set shadcn `rtl: true` BEFORE the first `shadcn add` (otherwise run `shadcn migrate rtl`), and set vaul's direction and sonner's position by hand. Lint allows logical (start/end) classes only.
- **Why:** One Tailwind version for the whole repo. shadcn supports RTL officially, and Uniwind is stable on Tailwind v4.
- **Rejected:** NativeWind v4 (needs Tailwind v3, which splits the tokens); NativeWind v5 (still an RC; fallback once stable); one shared theme.css (the two formats differ). Details: ARCHITECTURE.md §Styling, §i18n & RTL

### D-019 · 2026-09-24 · i18next on both platforms

- **Decision:** i18next + react-i18next with typed keys and Arabic's six plural forms. No locale in URLs; the locale comes from profiles.locale, then a cookie, then Accept-Language or expo-localization. On the Next server, create an instance per request with `createInstance()` inside React `cache()`, and never call a global `changeLanguage` on the server. Terminology overlays per business profile replace whole sentences. Formatting uses `ar-AE-u-nu-latn` (Latin digits). Arabic-Indic digits typed as input are normalized in domain. CI fails when an Arabic key is missing.
- **Why:** One engine and one set of plural rules on both platforms. Whole sentences keep Arabic gender and number agreement. The app requires login, so locale URLs bring no SEO benefit.
- **Rejected:** next-intl + use-intl (two engines, issues on RN); `$t(terms:…)` nesting inside sentences; `/en` and `/ar` routes. Details: ARCHITECTURE.md §i18n & RTL

### D-020 · 2026-09-24 · pnpm (hoisted) + Turborepo monorepo

- **Decision:** pnpm 10 (10.34.5) with `node-linker=hoisted` in `.npmrc`, catalogs in `pnpm-workspace.yaml` that pin one version of shared libraries (React 19.2 when apps arrive, TypeScript, Zod, tRPC, Query), Turborepo, `.gitattributes eol=lf`, and Renovate for fast Next.js security updates. **TypeScript 6.0**, not 7.0: typescript-eslint 8.x supports `<6.1` only (checked 2026-09-24).
- **Why:** Metro on Windows breaks with pnpm symlinks and duplicate React copies. pnpm 10 is still maintained and is what Expo/Metro setups are proven on; pnpm 11/12 can come later.
- **Rejected:** pnpm's default isolated linker; pnpm 12 and TypeScript 7 at this stage. Details: ARCHITECTURE.md §Repo structure

### D-021 · 2026-09-24 · The repo lives at `C:\dev\bizcost`, outside OneDrive

- **Decision:** The repo moved out of OneDrive to `C:\dev\bizcost`.
- **Why:** Cloud-syncing node_modules and .git causes file locks, slow installs and sync conflicts.
- **Rejected:** keeping the repo inside OneDrive. Details: ARCHITECTURE.md §Repo structure

## Security & tenancy

### D-022 · 2026-09-24 · A dedicated `bizcost_api` DB role, with FORCE RLS

- **Decision:** The API connects as `bizcost_api`: no BYPASSRLS, not a superuser, not the table owner. Tables live in schema `app`, which the Data API does not expose; anon and authenticated have zero grants on it. Every tenant table has ENABLE + FORCE RLS with one generated policy:
  `business_id = (select app.current_business_id()) AND (select app.is_active_member(app.current_business_id()))`
  No row column is passed to the function, so it runs once per query as an InitPlan (an EXPLAIN test checks for InitPlan, not SubPlan). `withTenantTx()` is the only way into the data, and it sets context with `set_config(…, true)`. CI/pgTAP checks that every table with business_id has RLS and the standard policy.
- **Why:** Supabase's `postgres` and `service_role` have BYPASSRLS, so "connect as owner, then SET role" fails open. A dedicated role fails closed: with no context, a query returns zero rows.
- **Rejected:** connecting as postgres with `set_config('role','authenticated')`; passing the row's column (`is_active_member(business_id)`), which runs once per row. Details: ARCHITECTURE.md §Tenancy & security

### D-023 · 2026-09-24 · Provisioning the role, and hardening SECURITY DEFINER functions

- **Decision:** Migrations create `bizcost_api` as NOLOGIN with default privileges (no UPDATE or DELETE on audit_log), plus `statement_timeout` and `idle_in_transaction_session_timeout`. The LOGIN PASSWORD is set per environment from a secret, following a runbook; it is never committed. Verify the pooler login as `bizcost_api.<ref>` in Step 0/1, with a dedicated pooler or a direct connection as the fallback. Pooling: transaction pooler on port 6543 with `prepare:false`, postgres.js `max:1` + `idle_timeout`, and `attachDatabasePool` on Fluid compute. SECURITY DEFINER functions live in `app` only, with `SET search_path = ''`, fully-qualified names and an explicit owner. REVOKE EXECUTE from PUBLIC, anon and authenticated; GRANT it to bizcost_api only. A pgTAP test checks the grants.
- **Why:** A password in a migration would sit in git and be identical in every environment. Postgres grants EXECUTE to PUBLIC by default, and an unpinned search_path can be exploited.
- **Rejected:** a LOGIN role created inside migrations; functions in `public`. Details: DATA_MODEL.md §1.1; ARCHITECTURE.md §Tenancy & security

### D-024 · 2026-09-24 · RLS only isolates tenants; permissions live in TypeScript

- **Decision:** RLS only keeps businesses apart. Roles, permissions, module gating and field redaction live in TypeScript, with pure evaluation in `domain`. Permission keys have the form `module.resource.action` and are declared in module manifests. Role templates are copied into each business as editable roles. The engine supports per-member allow/deny overrides and location scope. There are three independent gates: plan, module enabled, permission. The M1 UI covers only role templates, assigning a role, and editing role permissions. To handle stale data, invalidate `me` on FORBIDDEN, refetch on window focus, and send a `permissions_version` response header.
- **Why:** Permission logic lives in one testable place, with no double maintenance in SQL.
- **Rejected:** RLS policies per permission; a separate permissions package. Details: ARCHITECTURE.md §Permissions, modules & capabilities

### D-025 · 2026-09-24 · The active business goes in the URL or a header, not the JWT

- **Decision:** On the web the active business is in the URL (`/b/[businessId]`); on mobile it is stored on the device. It is always sent as `x-business-id`, and the server checks membership in the DB on every request. `profiles.last_business_id` picks where to go after login. The QueryClientProvider is keyed by businessId, so each business gets a fresh cache, and sign-out clears everything.
- **Why:** Different tabs can show different businesses, and removing a member takes effect on their next request. The cache cannot leak between businesses by design.
- **Rejected:** a custom JWT claim (goes stale and breaks multiple tabs); a `bz_biz` cookie (shared across tabs); relying on a manual `queryClient.clear()`. Details: ARCHITECTURE.md §Active business, §Data fetching & caching

### D-026 · 2026-09-24 · Redaction: automatic middleware and mandatory output schemas

- **Decision:** Every tRPC procedure must declare `.output()`; a CI check enforces it. `redact()` runs as automatic middleware, driven by sensitivity metadata on the output schema. It covers lists, details, reports, exports, search, errors and logs. Hidden fields are removed and listed in `meta.redacted`, so the UI shows a lock instead of a misleading 0. Aggregates are redacted in services. Filtering, sorting, grouping, searching or exporting on a hidden field returns FORBIDDEN. The sensitivity categories are cost, profit_margin, supplier_price, payroll and employee_pii; they are grouped so visible values cannot reveal a hidden one. An oracle test runs for every role template (notably the Employee/staff one), and Sentry scrubs cost values.
- **Why:** Hidden values never reach the device. Otherwise, filters and sorting could leak a value through binary search or ordering.
- **Rejected:** hiding fields in the UI only; calling redact() by hand; silently ignoring forbidden filters. Details: ARCHITECTURE.md §Permissions, modules & capabilities

### D-027 · 2026-09-24 · A custom Supabase domain before the first store build

- **Decision:** Prod gets a Supabase custom domain (e.g. `auth.<domain>`) before the first store build. The web client, `EXPO_PUBLIC_SUPABASE_URL` and signed Storage URLs all use it. CI fails if "supabase.co" appears in any bundle. A runbook covers a region move and a blocking incident.
- **Why:** `*.supabase.co` was reportedly blocked in the UAE (Sep 2025, about 18 days) and in India (Feb–Mar 2026). A URL baked into store builds cannot be changed quickly.
- **Rejected:** clients calling `*.supabase.co` directly. Details: ARCHITECTURE.md §Network exposure

### D-028 · 2026-09-24 · What deleting an account does

- **Decision:** In-app account deletion ships in M1, because Apple requires it. `created_by`, `updated_by` and `actor` store a UUID with no FK to auth.users. Deletion is blocked for the sole owner of a business that has other members; they must transfer ownership or delete the business first. The steps are: deactivate memberships, anonymize the profile (never hard-delete it), then call `auth.admin.deleteUser`. The `profiles` row is created by an upsert in the `me` procedure, not by a trigger on auth.users. Each business must keep at least one active owner, and transferring ownership is an explicit action. Business deletion and data export are defined in the docs only; there is no UI for them in M1.
- **Why:** An FK to auth.users would either block deletion or cascade into business data, and audit_log is append-only. A failing trigger would break signup.
- **Rejected:** FKs to auth.users; hard-deleting profiles; a trigger that creates profiles. Details: ARCHITECTURE.md §Auth; DATA_MODEL.md §1.3, §4 profiles

### D-029 · 2026-09-24 · Invitations: our own table, with rate limits

- **Decision:** Invitations use our own `business_invitations` table (email citext, token_hash, expires_at, status, role, location scope). Accepting requires a matching verified email. M1 enforces rate limits with DB counters (e.g. 20 invites a day per business, 3 resends per invite) and writes them to the audit log. Auth mail and notifications send from separate subdomains, ideally with separate API keys.
- **Why:** This blocks spam from our domain. If the mail provider suspended us for abuse, OTP login must keep working.
- **Rejected:** `auth.admin.inviteUserByEmail`; deferring all rate limiting. Details: DATA_MODEL.md §4 business_invitations

### D-030 · 2026-09-24 · Storage and server-only secrets

- **Decision:** Files go in a private bucket at the path `{business_id}/{entity}/{uuidv7}`. Uploads and downloads use only short-TTL signed URLs, which the API issues after a permission check. The bucket sets `file_size_limit` and `allowed_mime_types`; orphaned files are cleaned up later by background jobs. The secret key stays on the server (Auth admin, signed URLs, jobs). `adminDb` is a separate client that lint restricts. `import 'server-only'` goes in `packages/db` and `packages/api`.
- **Why:** A signed URL stays valid after membership is removed, so its TTL must be short. The build must fail if a secret reaches client code.
- **Rejected:** public buckets; clients accessing Storage directly. Details: ARCHITECTURE.md §Storage

## Data & numbers

### D-031 · 2026-09-24 · UUIDv7 IDs, idempotent creates, optimistic concurrency

- **Decision:** IDs are client-generated UUIDv7. Creates are idempotent: on an id conflict, compare business_id, created_by and `request_hash`. If they match, return the existing row; if not, return a typed CONFLICT. A `version` column provides optimistic concurrency. Optimistic UI is used for simple keys only; financial documents wait for the server.
- **Why:** Retries are safe on flaky mobile networks, and the path to offline stays open.
- **Rejected:** idempotency by id alone or `ON CONFLICT DO NOTHING` (both silently drop a changed payload). Details: DATA_MODEL.md §1.2

### D-032 · 2026-09-24 · Numeric column types; decimals travel as strings

- **Decision:** Postgres `numeric` only. Money: (20,4). Quantities: (24,6). Unit cost, base-unit cost and conversion factors: (28,12). Ratios: (9,6). In domain, values use decimal.js branded types. On the wire they are strings (`zDecimal`), and tRPC runs with no transformer. Lint bans `Number()` and `parseFloat` on money. Heavy aggregation runs in SQL. Every financial document has a `currency` column (the business default, AED); multi-currency support comes later.
- **Why:** Costing must be exact, and column types are very costly to change once data exists. Plain JSON also keeps a future REST API identical.
- **Rejected:** float/double; the Postgres `money` type; superjson. Details: DATA_MODEL.md §1.4 Numbers

### D-033 · 2026-09-24 · Two rounding policies

- **Decision:** There are two policies. Documents (purchase, sale and invoice lines; VAT) round half-up to the currency's minor unit from an ISO-4217 table (AED 2; KWD/BHD/OMR 3). The cost engine (unit cost, recipes, WAC) never rounds: it stores numeric(28,12) and rounds only for display. Display rounds with decimal.js first, then formats with Intl using min = max fraction digits. A golden test compares web and Hermes output.
- **Why:** Rounding recipe lines would turn tiny costs into zero (1 g of salt is about AED 0.004). A fixed 2 decimals breaks 3-decimal currencies, and Hermes Intl may coerce values to float.
- **Rejected:** a single rule of 2 decimals, half-up, per line. Details: ARCHITECTURE.md §Numbers, money, units & time

### D-034 · 2026-09-24 · Units: a base unit plus pack conversions

- **Decision:** Each material has a base unit in one dimension (mass, volume, count, length, area, time). Standard conversions live in code. Pack conversions (e.g. 1 carton = 12 bottles) are stored exactly, per material. Converting across dimensions needs an explicit factor. The chain is: purchase unit → pack → base unit → cost per base unit → recipe quantity.
- **Why:** Users enter materials the way they buy them, and the cost engine needs a single base.
- **Rejected:** conversions without a base unit. Built in Phase 2 (not M1). Details: DATA_MODEL.md §6 (Units, Materials)

### D-035 · 2026-09-24 · Time: UTC timestamps plus a business_date

- **Decision:** Timestamps are timestamptz in UTC. `businesses.timezone` defaults to Asia/Dubai. Every document has a `business_date`, and reports group by it. On the wire, timestamps are ISO and business_date is `YYYY-MM-DD`.
- **Why:** Each transaction must count on the business's local day.
- **Rejected:** timestamps without a timezone. Details: DATA_MODEL.md §1.5 Time

### D-036 · 2026-09-24 · Append-only ledgers and immutable posted documents

- **Decision:** `audit_log` is append-only (bizcost_api has no UPDATE or DELETE on it), and each row records the actor and request_id. Documents have a status of `draft | posted`. A posted document is immutable (enforced by a trigger), keeps cost snapshots, and is corrected with a reversal entry. Stock is planned as an append-only movement ledger. Soft delete uses `deleted_at` with partial unique indexes.
- **Why:** Costing and audits need a history people can trust.
- **Rejected:** hard deletes; editing posted documents. Details: DATA_MODEL.md §1.6

### D-037 · 2026-09-24 · Composite tenant foreign keys via `tenantTable()`

- **Decision:** The `tenantTable()` helper gives every tenant table: business_id, `UNIQUE(business_id, id)`, and composite FKs `(business_id, x_id) → (business_id, id)` on child tables. It also adds created/updated by and at, deleted_at, version, an index that leads with business_id, and FORCE RLS with the standard policy.
- **Why:** The DB itself stops a row from linking to another business's row. This is the costliest thing to add later.
- **Rejected:** a business_id column without composite FKs. Details: DATA_MODEL.md §1.2

## Auth

### D-038 · 2026-09-24 · Email + password, with 6-digit email codes (option A)

- **Decision:** Email + password, minimum 10 characters, with leaked-password protection on Pro and email confirmation on. A 6-digit code sent by email handles signup verification, password reset, and an optional "sign in with a code". Set `otp_length=6` explicitly in config.toml and in each project, with an expiry of about 600 s and a shared `AUTH_OTP_LENGTH` constant. Everything uses Supabase's built-in features.
- **Why:** The owner confirmed it, and codes (not links) need no deep links on mobile.
- **Rejected:** OTP 2FA on every login; phone OTP at launch (needs a UAE sender ID); magic links; social login and TOTP MFA at launch. Details: ARCHITECTURE.md §Auth

### D-039 · 2026-09-24 · Never reveal whether an account exists

- **Decision:** Code sign-in (`signInWithOtp`, `shouldCreateUser:false`) treats "Signups not allowed for otp" exactly like success and shows "If you have an account, we sent a code". The signup-code screen links to sign-in and to password reset, because signing up with an existing email sends no code. Supabase errors map to i18n keys by `error.code`, never by the message text.
- **Why:** Responses must not reveal whether an email is registered.
- **Rejected:** showing Supabase's raw errors. Details: ARCHITECTURE.md §Auth

### D-040 · 2026-09-24 · Bilingual, code-only email templates and custom SMTP

- **Decision:** Every auth template shows only `{{ .Token }}` and switches between English and Arabic with a Go conditional on `{{ .Data.locale }}`. `user_metadata.locale` stays in sync with `profiles.locale`. This covers the secure email change and reauthentication templates too. Custom SMTP (Resend) with SPF, DKIM and DMARC must be set up before any real user.
- **Why:** This gives bilingual mail without a hook that would make our API a point of failure for signup. Supabase's default SMTP is not fit for production.
- **Rejected:** a Send Email Hook in M1; Supabase's default SMTP; link-based templates. Details: ARCHITECTURE.md §Auth

### D-041 · 2026-09-24 · Session checks, and LargeSecureStore on mobile

- **Decision:** Use asymmetric JWT keys and the new publishable/secret keys. The server trusts only `getClaims()`, which verifies locally against JWKS for both cookie and Bearer tokens. Web uses @supabase/ssr with the Next `proxy.ts`. Expo uses supabase-js with LargeSecureStore: the AES key is in expo-secure-store and the encrypted session is in AsyncStorage. Set `android.allowBackup:false`, or exclude AsyncStorage from backups. If decryption fails, clear the session and show the user as signed out. Auto-refresh follows AppState. Sign-out uses `scope:'global'`.
- **Why:** SecureStore has a 2048-byte limit. A restored backup has no Keystore key, so decryption would crash the app.
- **Rejected:** a plain AsyncStorage session; SecureStore alone. Details: ARCHITECTURE.md §Auth

## Mobile

### D-042 · 2026-09-24 · iPad: `supportsTablet: false` in M1

- **Decision:** Set `ios.supportsTablet: false` for M1; iPad users use the web app. Native iPad support comes only once tablet layouts exist.
- **Why:** Apple does not allow removing iPad support after release. A stretched phone layout breaks the owner's "no stretched screens" rule and risks review rejection.
- **Rejected:** Expo's default `supportsTablet: true`. Details: ARCHITECTURE.md §Platform roles & parity

### D-043 · 2026-09-24 · Hermes Intl polyfills are mandatory

- **Decision:** In the mobile entry point, before i18next starts, load @formatjs/intl-getcanonicallocales, intl-locale, intl-pluralrules/polyfill-force and the ar/en locale data. Test Arabic plurals for 0, 1, 2, 3, 11 and 100, and test NumberFormat `ar-AE-u-nu-latn` with AED.
- **Why:** Hermes has no Intl.PluralRules, so Arabic plurals break on every device.
- **Rejected:** adding polyfills only if a device shows a problem. Details: ARCHITECTURE.md §i18n & RTL

### D-044 · 2026-09-24 · Switching language direction restarts the mobile app

- **Decision:** Switching between English and Arabic calls `I18nManager.allowRTL/forceRTL`, then `Updates.reloadAsync()`, after a notice that the app will restart. Test RTL in dev builds only, not Expo Go.
- **Why:** React Native applies layout direction only at startup.
- **Rejected:** testing in Expo Go. Details: ARCHITECTURE.md §i18n & RTL

## Process

### D-045 · 2026-09-24 · Docs are the source of truth for future sessions

- **Decision:** Five docs in `/docs` (PRODUCT, ARCHITECTURE, DATA_MODEL, ROADMAP, DECISIONS) hold the long-term context. Each owns one topic and cross-references the others. Read only the docs that are relevant, update the doc that owns a topic when it changes, and do not restate the spec.
- **Why:** The owner requires token efficiency and stable context across sessions.
- **Rejected:** the draft's ~20 ADRs plus 8 topic docs. Details: this file's header

### D-046 · 2026-09-24 · Milestone by milestone, with owner approval gates

- **Decision:** Work one milestone and one step at a time; the owner approves each milestone before the next begins. Web leads M1, with a 2–3 day Expo spike right after the API core; mobile M1 ends in TestFlight and Play internal builds. Do not build future phases early: no cost engine, inventory/waste math, AI, POS APIs, payroll, full VAT or advanced reporting. Ask the owner only when a missing decision would cause significant rework, and report the files changed.
- **Why:** This is the owner's rule; it keeps a solo build focused and surfaces mobile risks in weeks 1–2.
- **Rejected:** fully parallel web and mobile builds; deferring all mobile work to M2; speculative scaffolding. Details: ROADMAP.md §Milestone 1
