# BizCost: Decision Log

Purpose: a numbered record of every confirmed decision, why we made it, and what we rejected. The details live in the doc each entry links to.
Last updated: 2026-09-25

- **Status:** every entry is DECIDED. Implemented so far: the Step 0a repo scaffold, the Step 1 data foundation (D-047–D-053 and the data/tenancy entries they build on), the Step 2 API core (D-054–D-061), the Step 3 web auth (D-062–D-071), the owner's password rule (D-072) and the "too soon" fix (D-073). "Open:" marks a sub-choice that is still unsettled, tracked in ROADMAP.md §Open, with deadline.
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

Superseded in part by D-072: passwords are now at least 8 characters with a letter (a-z) and a number (0-9).

- **Decision:** Email + password, minimum 10 characters, with leaked-password protection on Pro and email confirmation on. A 6-digit code sent by email handles signup verification, password reset, and an optional "sign in with a code". Set `otp_length=6` explicitly in config.toml and in each project, with an expiry of about 600 s and a shared `AUTH_OTP_LENGTH` constant. Everything uses Supabase's built-in features.
- **Why:** The owner confirmed it, and codes (not links) need no deep links on mobile.
- **Rejected:** OTP 2FA on every login; phone OTP at launch (needs a UAE sender ID); magic links; social login and TOTP MFA at launch. Details: ARCHITECTURE.md §Auth

### D-039 · 2026-09-24 · Never reveal whether an account exists

Superseded in part by D-062: "send me a code" now creates a missing account.

- **Decision:** Code sign-in (`signInWithOtp`, `shouldCreateUser:false`) treats "Signups not allowed for otp" exactly like success and shows "If you have an account, we sent a code". The signup-code screen links to sign-in and to password reset, because signing up with an existing email sends no code. Supabase errors map to i18n keys by `error.code`, never by the message text.
- **Why:** Responses must not reveal whether an email is registered.
- **Rejected:** showing Supabase's raw errors. Details: ARCHITECTURE.md §Auth

### D-040 · 2026-09-24 · Bilingual, code-only email templates and custom SMTP

- **Decision:** Every auth template shows only `{{ .Token }}` and switches between English and Arabic with a Go conditional on `{{ .Data.locale }}`. `user_metadata.locale` stays in sync with `profiles.locale`. This covers the secure email change and reauthentication templates too. Custom SMTP (Resend) with SPF, DKIM and DMARC must be set up before any real user.
- **Why:** This gives bilingual mail without a hook that would make our API a point of failure for signup. Supabase's default SMTP is not fit for production.
- **Rejected:** a Send Email Hook in M1; Supabase's default SMTP; link-based templates. Details: ARCHITECTURE.md §Auth

### D-041 · 2026-09-24 · Session checks, and LargeSecureStore on mobile

The sign-out scope is refined by D-066 (header: this device; account page: every device).

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

## Data foundation (Step 1)

### D-047 · 2026-09-25 · Migration layout, API role details and the local password

- **Decision:** Four migrations: `app_schema` (generated), `api_role_and_context` (custom), `m1_tables` (generated), `tenancy_security` (custom: functions, triggers, RLS, grants). Custom ones are made with `drizzle-kit generate --custom`, so Drizzle's journal in `supabase/migrations/meta/` (ignored by the Supabase CLI) stays consistent and CI's drift check works. `bizcost_api` also gets `search_path = extensions` (citext operators), and `postgres` may `SET ROLE bizcost_api` without inheriting its rights (pgTAP). Locally only, `supabase/seed.sql` sets the password `bizcost_local_dev` and refuses to run unless it sees the local stack's demo JWT secret. `db push --include-seed` and `db reset --linked` are forbidden.
- **Why:** The context functions must exist before the tables (the `created_by` default calls one). The Supabase CLI can apply seeds to hosted projects, so the seed must not rely on "seeds only run locally".
- **Rejected:** a separate Drizzle journal folder; setting the local password from test tooling (the web app needs it too). Details: DATA_MODEL.md §1.1

### D-048 · 2026-09-25 · Identity-table policies, co-member names, and two indexes not led by business_id

- **Decision:** `profiles`: own row (select/insert/update, no delete). `businesses`: read those where the caller is an active member (`app.my_business_ids()`), update only the current one; no insert/delete policy. `business_members`: the tenant policy, plus reads of the caller's own memberships in every business (switcher). `business_invitations` and `audit_log`: the tenant policy. Co-members' names come from `business_members.display_name`, which is NOT NULL for every kind; the API keeps it in sync with the profile. Two indexes do not lead with business_id: global `UNIQUE (token_hash)` and `business_members (user_id)`.
- **Why:** Profiles stay private, and the switcher works before a business is chosen. The token is looked up before the business is known, and per-user lookups would otherwise scan every business's members.
- **Rejected:** a membership-scoped read of other users' profiles. Details: DATA_MODEL.md §2, §4

### D-049 · 2026-09-25 · Bootstrap functions; the Owner's permissions are implicit

- **Decision:** `app.create_business()` inserts the business, one role with `template_key 'owner'`, and the caller's active account membership. The other role templates and the default location come from Smart Setup (Step 5). The Owner template holds every permission implicitly (no `role_permissions` rows). `app.accept_invitation(token, member_id)` hashes the token (SHA-256 hex), requires the caller's verified auth email to match, and raises one generic `invitation_invalid` for every token/email failure (`already_member` only after both match). Rows the database writes itself (audit rows, the overrides and locations created on acceptance) get ids from `app.uuid_v7()`; everything else keeps client ids (D-031).
- **Why:** RLS blocks these first writes by design. An Owner must never lose access because a new permission key was added.
- **Rejected:** copying every permission into an Owner role; revealing whether a token exists. Details: DATA_MODEL.md §2, §4

### D-050 · 2026-09-25 · Audit rows are written only by a database trigger

- **Decision:** `app.audit_row()` (SECURITY DEFINER) runs AFTER INSERT/UPDATE/DELETE on `businesses` and every tenant table. It records the actor and `request_id` from the tenant context and `{before, after}` without secret columns (`token_hash`, `pin_hash`). `bizcost_api` has SELECT only on `audit_log`: no INSERT either (changed from the Step 1 plan after the security review).
- **Why:** No write path can skip the audit, and a member cannot forge rows (another actor, a backdated time).
- **Rejected:** auditing in API services; an INSERT grant for the API. Details: DATA_MODEL.md §1.6, §4 audit_log

### D-051 · 2026-09-25 · "At least one active Owner" is enforced by the database

- **Decision:** A DEFERRABLE INITIALLY DEFERRED constraint trigger checks at commit that every live business keeps an active, non-deleted account member whose role has `template_key 'owner'`. It fires on `business_members` writes, on `roles` `template_key`/`deleted_at` changes and on restoring a soft-deleted business; soft-deleted businesses are exempt. An advisory lock serialises the checks per business, and the owner it relies on is confirmed with `FOR SHARE NOWAIT`, so concurrent removals fail with 23514, or 40001 in REPEATABLE READ/SERIALIZABLE (the API retries 40001).
- **Why:** Ownership transfer must work in one transaction, and the rule must hold under any isolation level the API role can pick.
- **Rejected:** API-only checks; an advisory lock alone (a stale REPEATABLE READ snapshot slips through). Details: DATA_MODEL.md §4 businesses

### D-052 · 2026-09-25 · `vat_registered` is stored once, on `businesses`

- **Decision:** A capability that mirrors a `businesses` column is read from that column. `business_capabilities` has CHECK `key <> 'vat_registered'`.
- **Why:** One source of truth; two copies would drift.
- **Rejected:** a mirrored capability row kept in sync. Details: DATA_MODEL.md §4 business_capabilities

### D-053 · 2026-09-25 · Shape of `@bizcost/db`

- **Decision:** `packages/db` is server-only (`import 'server-only'`). It exports `createDb(url)` (postgres.js with `prepare:false`, `max` 1 by default, `idle_timeout` 20, plus Drizzle), `withTenantTx(db, {userId, businessId, requestId}, fn)`, the schema tables and their types. `newId()` (UUIDv7) and the stored keys/enums (`OWNER_TEMPLATE_KEY`, member kinds and statuses, …) live in `@bizcost/domain`. No `adminDb` until a step needs it. Turborepo `test`/`lint` depend on a `transit` task, so a change in a workspace dependency re-runs its dependents.
- **Why:** Pure code (permission engine, contracts) needs the same keys without importing the DB layer, and cached test results must not hide a broken dependency.
- **Rejected:** constants in the schema files; `adminDb` in Step 1. Details: ARCHITECTURE.md §Database access

## API core (Step 2)

### D-054 · 2026-09-25 · Permission engine rules; an empty location set means all locations

- **Decision:** `resolveEffective` in `domain` is pure and receives the permission catalog. The owner template holds every permission (`all`, including keys added later) and its overrides are ignored. Everyone else gets (role keys ∪ allow overrides) − deny overrides, limited to the catalog: deny wins and unknown keys are dropped. An empty `member_locations` set means all locations of the business, including ones added later; a non-empty set limits the member to those locations. Each sensitivity category is unlocked by `data.<category>.view`, and `profit_margin` is visible only when `cost` is visible too.
- **Why:** An owner can never be locked out, and a retired or mistyped key can never grant access. Most members of a small business work everywhere, so "all" is the zero-setup default and a new location needs no re-assignment. Price + margin would reveal a hidden cost.
- **Rejected:** empty set = no locations (every member would need rows, and a missing row would lock people out silently); category keys without the grouping rule. Details: ARCHITECTURE.md §Permissions, modules & capabilities; DATA_MODEL.md §4 member_locations

### D-055 · 2026-09-25 · Shape of `@bizcost/modules` and `@bizcost/contracts`

- **Decision:** `modules` has one manifest line for every module of PRODUCT.md §7 (`id, kind, availability, phase, deps, permissionKeys, nav, quickActions, sensitiveFields, requiresCapabilities`). Planned modules get permission keys, nav and actions only when they are built. Dashboard and Settings are the only released modules and are always on without a `business_modules` row; every other module, core or optional, is on only through its row (superseded by D-059: core modules are on by default). The Settings nav entry needs no permission, because every member reaches their own profile and language there. The permission catalog is the manifests' keys plus one `data.<category>.view` key per sensitivity category. Role templates (owner, admin, manager, accountant, sales, supervisor, employee) are data in `modules`; admin gets every catalog key as rows, and ownership transfer stays owner-only without a key. Capabilities are `stored` (`business_capabilities`) or `derived` (`vat_registered`, D-052). In `contracts`, `sensitive(schema, category)` tags a copy of the schema in a dedicated Zod registry and makes the field optional, because redaction can remove it; `withMeta()` wraps outputs that contain such fields.
- **Why:** One source for nav, "+", Smart Setup and API guards. A core module such as Materials must still be switchable (a services-only business does not use it), so "core" does not mean "always on". An optional field makes clients handle the redacted case instead of showing a misleading 0.
- **Rejected:** enabling every core module implicitly (superseded by D-059, which keeps core modules switchable); free-form `.meta()` tags; tagging shared schema instances such as `zDecimal`. Details: ARCHITECTURE.md §Modules, §Permissions, modules & capabilities

### D-056 · 2026-09-25 · Access tokens: asymmetric only, verified with getClaims; a local signing key

- **Decision:** The API verifies every session (cookies through `@supabase/ssr`, or `Authorization: Bearer` from mobile; the header wins when both are present) with `supabase.auth.getClaims()` only, and accepts only ES256/RS256 tokens: an HS* token is rejected before `getClaims()` is called. The claims must also have `role` and `aud` `authenticated`, a UUID `sub` and `is_anonymous` false. A JWKS or refresh outage is an internal error, not a sign-out. Locally, `pnpm auth:signing-key` generates a per-machine ES256 key into the gitignored `supabase/signing_keys.json` (`config.toml` `signing_keys_path`); CI generates a throwaway one per run and starts Postgres, Auth and the gateway with `supabase start -x …`, because `supabase db start` has no Auth server. `emailVerified` in the API context is a UI hint only (`user_metadata` is user-writable); checks that need a verified email stay in the database.
- **Why:** For an HS* token `getClaims()` falls back to asking the Auth server, which accepts any token signed with the legacy JWT secret; an integration test forges one with the local legacy secret and `getClaims()` alone accepts it. Asymmetric verification is local (no network hop per request), and the CLI's built-in local key is the same on every machine.
- **Rejected:** trusting the HS256 fallback; `getUser()`/`getSession()` for trust; committing a local key. Details: ARCHITECTURE.md §API & request flow, §Local setup

### D-057 · 2026-09-25 · Shape of `@bizcost/api`

- **Decision:** One tRPC instance with three bases (`publicProcedure`, `authedProcedure`, `businessProcedure`) and the order `mapErrors → appVersionGate → originCheck → [authed → businessScoped] → redact → [requireModule → requirePermission] → output validation → handler`. `businessScoped` loads all access data in one statement inside `withTenantTx`, memoized per request, and gives the same FORBIDDEN for "not a member" and "no such business"; a missing or malformed `x-business-id` is `validation`. `redact` reads the served procedure's Zod output schema from the router and fails closed (INTERNAL) for sensitive fields outside a business procedure or outside `withMeta()` (see D-060); `sensitive()` is allowed on object fields only; `meta.redacted` lists schema paths relative to `data` with `*` for array items and record values, present or not. Every procedure is checked by a contract test. Errors carry `appCode` + `i18nKey`; SQLSTATEs map to conflict/validation/forbidden; production messages are the app code with no stack; `app_version_unsupported` is HTTP 412 and a malformed `x-app-version` counts as unsupported. The origin check covers every mutation without an `Authorization` header, signed in or not. `me` lists only businesses the caller can open (active memberships of live businesses) and reads each role in that business's own `withTenantTx`. `insertIdempotent()` lives in `packages/db` and throws `ConflictError`. `createContext` takes `{ req, resHeaders, deps, router }` (the redactor needs the served router), so a server-side caller passes the same deps and `appRouter`.
- **Why:** Guards that live in the procedure bases cannot be forgotten by a procedure, and a redactor that cannot place a tag must refuse rather than leak. Listing hidden paths from the schema lets the UI lock a column even for an empty list, and reveals nothing through presence. Roles are tenant rows, so reading them per business keeps `me` inside the existing policies instead of adding a SECURITY DEFINER function.
- **Rejected:** redaction by a per-procedure helper (can be skipped); listing only the removed values' paths; a new SECURITY DEFINER function for `me`'s role list; checking `Origin` only for signed-in requests. Details: ARCHITECTURE.md §API & request flow, §Permissions, modules & capabilities

### D-058 · 2026-09-25 · Telemetry collects the minimum and is scrubbed

- **Decision:** Sentry runs on the server only and only when `SENTRY_DSN` is set, with `dataCollection` off for user info, cookies, request/response bodies, query strings, DB query data and stack-frame variables. `beforeSend` drops request bodies, cookies and query strings (tRPC GET inputs live there), replaces any key like cost/profit/margin/price/salary/wage/payroll or a credential, keeps only `user.id`, and removes Drizzle's bound `params:` from messages and every exception in the cause chain. Internal API errors also go to the function log with the request id, scrubbed the same way.
- **Why:** Redaction covers errors, logs and telemetry (ARCHITECTURE.md §Permissions); a failed query's bound values or a local variable can carry a cost.
- **Rejected:** Sentry defaults; client-side Sentry before there are pages. Details: ARCHITECTURE.md §Secrets & server-only code

### D-059 · 2026-09-25 · Core modules are on by default; rows switch modules on or off

- **Decision:** A core module is on for every business unless its `business_modules` row sets `enabled = false`; an optional module is on only through a row with `enabled = true`; Dashboard and Settings are always on and their rows are ignored (`resolveEnabledModules` in `modules`). `requireModule` and `business.context` use the resolved set, so a module still has to be released to be served or shown. Smart Setup (Step 5) writes `enabled = false` rows for the core modules a business does not use (e.g. Materials for services only).
- **Why:** The lead's Step 2 rule: releasing a core module (Phase 2) must not need a backfill of rows for every existing business, and a missing row must not hide a core module. Core modules stay switchable in Customize BizCost, as PRODUCT.md §5 requires.
- **Rejected:** core modules on only through a row (every release of a core module would need a backfill); core meaning "cannot be switched off" (a services-only business does not use Materials). Details: ARCHITECTURE.md §Modules; DATA_MODEL.md §4 business_modules

### D-060 · 2026-09-25 · Output schemas are fully typed; the redactor fails closed before the handler

- **Decision:** The redactor accepts only schemas it can follow: objects (with `.catchall()` values under `*`), arrays, records, tuples, unions, intersections, pipes without a transform, `z.preprocess`, codecs, `z.lazy`, field wrappers and leaf types. `z.unknown()`/`any()`/`custom()`, loose/passthrough objects, `.transform()` results, Map/Set/promise and unknown Zod types are a `SensitiveSchemaError`, as is a `sensitive()` tag that is not on an object field (tags behind wrappers, pipes and `z.lazy()` count as on the field). The `redact` middleware runs this check before the handler, so a refused procedure has no side effects; the contract test reports the same errors for every procedure. The wrapper list is shared from `contracts` (`FIELD_WRAPPER_TYPES`).
- **Why:** A security review showed tags under `.catchall()` and `z.lazy()` were invisible and their values were served to every member, and an untyped output can carry raw rows with cost columns that nothing detects. Rejecting whatever the walker does not understand keeps new Zod features from opening the same hole.
- **Rejected:** best-effort walking that ignores unknown types; allowing `.transform()` in outputs (its result is not described by any schema; use `.overwrite()` or map in the handler). Details: ARCHITECTURE.md §Permissions, modules & capabilities

### D-061 · 2026-09-25 · Hardening of the API entry: tokens, batches and the database pool

- **Decision:** (1) Before `getClaims()`, a token (Bearer or the cookie session's access token) must have a JSON header with ES256/RS256 and a `kid` and a JSON payload with a numeric `exp`; anything `getClaims()` returns or throws for a bad token is 401 and is not reported, and only an unreachable Auth server is `internal`. (2) A batch holds at most `API_MAX_BATCH_SIZE` = 20 calls (400 otherwise; clients set `maxItems` to it), and `me` is memoized per request. (3) The context never holds the pool: `ctx.tenantTx` binds `withTenantTx` to the verified caller and the request id, and lint allows `withTenantTx`/`createDb` only in `context.ts`. Lint also enforces the layer order domain → contracts → modules → db → api. (4) `SENTRY_DSN` is read only by `instrumentation.ts`, never by the API's env schema.
- **Why:** Crafted tokens made auth-js throw (WebCrypto `DataError`, JSON `SyntaxError`), turning 401 into 500 and flooding error reporting; a token without `kid` made auth-js ask the Auth server on every request. One unbounded batch of `me` held the single connection for seconds. A pool on the context was guarded only by a narrow lint selector. A malformed optional DSN failed every API request.
- **Rejected:** accepting RS256 only when the JWKS has an RSA key (the key-type mismatch is already a 401); a larger pool instead of a batch limit (still unbounded work per request). Details: ARCHITECTURE.md §API & request flow, §Package dependency rules

## Web auth (Step 3)

### D-062 · 2026-09-25 · Account existence: what the app hides, and what Supabase still reveals

Refined in part by D-073: a code request answered "too soon" is sent again once, and a new address signed up again in the same tab within a minute looks like the first sign-up.

- **Decision:** (1) `[auth.sms] enable_confirmations = true` (BizCost has no phone sign-in): with SMS auto-confirm on, Supabase answers a sign-up with a registered email with `user_already_exists` instead of the answer a new email gets. (2) "Send me a code" calls `signInWithOtp({ shouldCreateUser: true })` with the page language in `data.locale`: an address without an account gets one (unconfirmed until the code is entered; its email is the sign-up code), so a registered and a new address get the same `200 {}`. The code screen says "We sent a code to …". This supersedes the `shouldCreateUser:false` part of D-039. (3) A sign-up that hits the email rate limit shows "We can't send you an email right now" instead of pretending a code was sent (a new address can only hit the project-wide budget, which reveals nothing); the code requests keep treating it as success. (4) `[auth.rate_limit] email_sent = 100` per hour, a production value for custom SMTP (Supabase's default of 2 would let any visitor use up the budget). (5) Still revealed by Supabase's public endpoints, and accepted for now: `/recover` answers a second request within 60 s with 429 only for a registered address; response timing (creating an account takes longer); `email_exists` when a signed-in user changes to an address in use. Mitigations: per-IP rate limits, and CAPTCHA (Cloudflare Turnstile on sign-up, code and reset) before the first real user (owner action).
- **Why:** The Step 3 security review showed the browser itself receives different answers (`otp_disabled` 422 vs 200, `user_already_exists` 422 vs 200), so a stranger could list accounts with the publishable key. A code for a new address is also what a person on the wrong tab most likely wants.
- **Rejected:** proxying auth calls through our API (the public endpoint stays callable, and every rate limit would see one server IP); keeping `shouldCreateUser:false` (it cannot give the same answer); promising more than the platform can hold ("the screens never reveal" is the promise; the API-level gaps above are listed). Details: ARCHITECTURE.md §Auth

### D-063 · 2026-09-25 · "Confirm it's you" is an emailed code that Supabase checks

- **Decision:** Changing the password (and deleting an account signed in more than 10 minutes ago, D-064) first emails the user's own sign-in code (`signInWithOtp`, `shouldCreateUser:false`) and checks it with `verifyOtp(type 'email')`, which also renews the session; only then is `updateUser({ password })` sent. The app does not call `reauthenticate()`. The magic-link template's wording is neutral ("Your BizCost code … to continue") because it serves sign-in and this check. Remaining gap: Supabase lets any session younger than 24 hours call `updateUser({ password })` directly, so a stolen fresh session can still change the password outside the app; when the Supabase CLI supports them, turn on "require the current password" and the "password changed" email.
- **Why:** With `secure_password_change`, Supabase checks the `reauthenticate()` nonce only for sessions older than 24 hours, so on a fresh session any 6 digits changed the password (a misleading step). `verifyOtp` is always checked by the server, and a wrong code never reaches the password update.
- **Rejected:** the `reauthenticate()` nonce (not enforced); asking for the current password in the UI only (not enforced either, and accounts created by a code have none); checking Supabase's nonce hash in our database (copies Auth internals). Details: ARCHITECTURE.md §Auth

### D-064 · 2026-09-25 · Account deletion as built

- **Decision:** `account.delete` checks before any change: the secret key is set; the caller is not the only active owner of a business with other members (`sole_owner`); the Auth admin API works (`getUserById`: a wrong or rotated key or an outage is `internal`); the newest `amr` entry of the access token is at most `AUTH_RECENT_SIGN_IN_SECONDS` = 600 s old (`reauth_required`, HTTP 403; the web dialog then emails a D-063 code and retries). Then, per business in its own transaction (the tenant context is one business): a business whose only member is the caller is soft-deleted after its row is locked `FOR UPDATE` and the plan re-checked (adding a member takes a key-share lock on that row, so it either commits first and blocks the deletion, or waits); the caller's membership becomes `removed` with display name 'Deleted user'. Last, in one transaction, the profile is anonymized and the auth user deleted with the Admin API, so a failed Admin call rolls the anonymization back. Every step is idempotent; if the auth user is already gone, a retry only finishes the anonymization.
- **Why:** The review showed a wrong secret key left a live account with its business deleted and its name anonymized, and a fresh or stolen session could delete everything with one click. Per-business transactions follow from the one-business tenant context; a member joining between the check and the write is the remaining window, and a half-finished deletion (some businesses already left) is simply retried.
- **Rejected:** one transaction across businesses (not possible with the tenant context); SERIALIZABLE with retries (the row lock is enough for M1's join paths); deleting the auth user first (a failed database step would leave data nobody can clean up). Details: ARCHITECTURE.md §Auth; DATA_MODEL.md §4 businesses

### D-065 · 2026-09-25 · Deleted accounts' tokens, and the name co-members see

- **Decision:** Access tokens are verified locally, so a deleted account's token stays valid until it expires (up to 1 hour). Every `authedProcedure` (outside a business) therefore checks once per request that the caller's profile is not anonymized (`unauthorized` otherwise; the web shows "session ended"), and `account.updateProfile` changes only a profile that is not anonymized. Business procedures need no extra check: deletion removes every membership first. A new display name is copied to the caller's active memberships (`business_members.display_name`), each in its business's own transaction, as D-048 requires.
- **Why:** The review showed a deleted user could keep calling `me` and rename the anonymized profile back, and that co-members kept seeing a deleted person's name or email.
- **Rejected:** a shorter JWT lifetime (more refreshes, still a window); a database trigger that copies names across businesses. Details: ARCHITECTURE.md §API & request flow

### D-066 · 2026-09-25 · Sign-out: this device from the header, every device from the account page

- **Decision:** "Sign out" in the app header ends this device's session (`signOut({ scope: 'local' })`, which also revokes it on the server). "Sign out everywhere" on the account page, behind a confirmation, ends every session (`scope: 'global'`). This refines D-041 ("sign-out uses `scope:'global'`"); mobile follows the same split in Step 8.
- **Why:** Signing out on a shared computer should not silently sign the user out of their phone, and two actions with the same effect were described differently.
- **Rejected:** global sign-out from the header (surprising); a confirmation on every sign-out. Details: ARCHITECTURE.md §Auth

### D-067 · 2026-09-25 · Arabic tone and the default language

- **Decision:** Arabic UI copy is simple, friendly Modern Standard Arabic (فصحى مبسطة): short sentences, no accounting jargon, gender-neutral where possible ("أدخل" is fine as the usual imperative), and the glossary in PRODUCT.md §13 (e.g. the brand line "اعرف تكلفتك الحقيقية. وطوّر أعمالك."). English is plain and short. Latin digits (`ar-AE-u-nu-latn`); Arabic-Indic digits are accepted in inputs. A visitor gets the `bz_locale` cookie's language, else the first `ar*`/`en*` of Accept-Language, else Arabic. For a signed-in user `profiles.locale` wins: the (app) layout writes it to the cookie when they differ. A new profile is named after the email's local part, so home says "Welcome to BizCost" until the user sets a name. The owner's Gulf wording for the Smart Setup questions stays open until Step 5.
- **Why:** The lead settled the tone for Step 3 (F1). A cookie-first order lets every page render without a database call.
- **Rejected:** Gulf dialect across the app; greeting people by their email prefix. Details: PRODUCT.md §13; ARCHITECTURE.md §i18n & RTL

### D-068 · 2026-09-25 · Auth emails as built

- **Decision:** Five templates in `supabase/templates` (confirmation, magic_link, recovery, email_change, reauthentication) show only `{{ .Token }}`, in its own table cell, with inline styles and the brand blue. Body and subject switch language on `user_metadata.locale` (`"en"` gives English, anything else Arabic with `dir="rtl"`), since Supabase evaluates Go templates in subjects too. `user_metadata.locale` is set at sign-up (and by a code request that creates an account) and updated with `profiles.locale` when the user changes language. Locally, a new template or subject needs the Auth container recreated; edits to an existing file are picked up by Auth.
- **Why:** One code per email, readable in both languages, without a Send Email Hook (D-040).
- **Rejected:** one bilingual subject line (not needed); links in emails. Details: ARCHITECTURE.md §Auth

### D-069 · 2026-09-25 · Shape of the web auth code

- **Decision:** `packages/tokens` generates `theme.web.css` and `theme.native.css` from `tokens.ts` (a test keeps them current). `packages/i18n` (no React) gives a new i18next instance per call, typed keys, formatters and `dir()`. `packages/app-core` holds the auth flows as reducers with small controllers around an injected supabase-js client, the client form schemas (`zod/mini`, so the browser bundles no Zod locales) and the tRPC/Query setup; the pure packages are marked `sideEffects: false`. `apps/web` uses Tailwind v4 + shadcn/ui (`rtl: true`), IBM Plex Sans + IBM Plex Sans Arabic, `proxy.ts` for session refresh and routing, a sessionStorage hand-off from a code request to `/verify` or `/reset` (only the email, the purpose and the send time) and a server-side `me` for the (app) layout. Session cookies are `Secure` except on plain http to a host other than localhost. Every response sends `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, HSTS, `nosniff` and a strict referrer policy, and no `X-Powered-By`. Tap targets are at least 44 px, except on large screens with a mouse. Deferred: the browser bundle still holds both languages' messages (~24 KB gzip); split them per locale when Steps 5–6 add namespaces.
- **Why:** Mobile (Step 8) reuses the flows and schemas. The review measured 113 KB gzip of Zod locales on every page and found non-Secure session cookies and no anti-framing headers.
- **Rejected:** Server Actions for auth; classic Zod in the browser. Details: ARCHITECTURE.md §Repo structure, §Styling, §i18n & RTL

### D-070 · 2026-09-25 · End-to-end tests

- **Decision:** Playwright (Chromium only) in `tests/e2e` runs against a production build of `apps/web` in its own folder (`.next/e2e`, via `NEXT_DIST_DIR`) on `E2E_PORT` (default 3100), with the local stack's Auth and Mailpit (codes are read from the email's code cell). Locally: `pnpm e2e`. In CI it runs in the `db` job after the API tests, with Mailpit started, and uploads its results on failure. It stays out of `pnpm check`. Test addresses are letters only, so no digits sit next to a code.
- **Why:** The flows need a real Auth server and real emails; a production build avoids first-visit compile timeouts and can run next to a developer's `next dev`.
- **Rejected:** `next dev` for e2e (slow first visits, clashes with a running dev server); keeping e2e local-only (the CI job already starts Auth). Details: ARCHITECTURE.md §Testing & CI

### D-071 · 2026-09-25 · Password reset: the code first, then "change password or go straight in"

- **Decision:** The owner's change to the Step 3 reset. After "Forgot password", `/reset` asks only for the emailed code (resend after 60 s, the spam hint, "use a different email", back to sign-in). `verifyOtp(type 'recovery')` checks it and signs the user in; the same screen then asks "Do you want to change your password?" with "Change password" (the new password twice, `updateUser({ password })`, which also ends the other sessions, then home) and "Continue without changing" (home, as after any sign-in; like a code sign-in (D-062) it keeps the password and the other devices signed in). The recovery code is the D-063 "confirm it's you" check for this change: `createPasswordReset` (code → choose → password → done) sends the new password only from the flow that verified the code, and only through the session that code created (the `session_id` claim of `getSession`'s access token must match the one `verifyOtp` returned; it survives a token refresh, a later sign-in of the same user does not); otherwise, or when Supabase refuses the session, this device is signed out ("Your password was not changed", with "Send a new code" and "Sign in"). **A code that confirmed the address requires a new password:** when the `verifyOtp` user's `email_confirmed_at` is not earlier than its `recovery_sent_at` (or either is missing), the account had never been confirmed, so its password was chosen by whoever signed up with the address (anyone can, with the publishable key); the choice is skipped and there is no way back to it, so that password is replaced and the other sessions end. The choice is page state, not a URL. sessionStorage records only that the code was used and whether a password is required. Opened again after the code (a reload, Back, Forward): still signed in and no password required → "You're signed in" with "Continue" (a password change then goes through the account page and its own code); otherwise this device is signed out and "Send a new code" starts again, keeping the requirement for this tab (also through `/forgot` for the same address). Back from `/reset` to `/forgot` while signed in returns to `/reset`. Wrong or expired codes and resend behave as before (errors by `error.code`, the same answer for any address); a wrong code is cleared and the cells get focus again. The code screen is shared with `/verify` (`CodeCard`).
- **Why:** The owner wants reset to feel like signing in with a code: many people only want to get in, and a new password is optional. Without the confirmation check, "Continue" would keep a stranger's pre-registered password on the victim's account (found by the security review; the Step 3 reset always replaced it). "Continue" does not end the other sessions: an attacker who knows the password would sign in again anyway, and it would sign the user's own phone out on every reset; "Sign out everywhere" (D-066) is on the account page. Not signing out a device that is still signed in after a reload keeps the reset from ending in a password form for someone who just said they forgot their password.
- **Known gaps (tracked in ROADMAP.md §Open):** the confirmation check sees only the code that confirmed the address, so if that reset is abandoned (another tab or device, or leaving the page) a later reset looks like a normal account; and the older paths that confirm a pre-registered address (the sign-up code, "Send me a code") keep the stranger's password too. Both need a server-side rule (e.g. an Auth hook or a database trigger).
- **Rejected:** the code and new password on one form (the Step 3 design); a separate URL for the new password (it could be opened without a just-verified session); restoring the choice or the password form after a reload from sessionStorage (the browser can edit it, so it would allow a password change without a code, against D-063); comparing raw access tokens (they rotate on refresh); always requiring a new password (against the owner's request). Details: ARCHITECTURE.md §Auth

### D-072 · 2026-09-25 · Password rule: at least 8 characters, a mix of (a-z, 0-9)

- **Decision:** The owner's change to D-038's "minimum 10 characters". A new password (sign-up, reset → new password, account → change password) needs at least 8 characters, at least one ASCII letter (a-z or A-Z) and at least one ASCII digit (0-9), and at most 72 UTF-8 bytes as before. The Auth server is the source of truth: `[auth] minimum_password_length = 8` and `password_requirements = "letters_digits"` in `supabase/config.toml` (hosted projects get it with `supabase config push`; locally the Auth container must be recreated, `supabase stop && supabase start`). The browser applies the same rule first: `AUTH_PASSWORD_MIN_LENGTH = 8` (`@bizcost/contracts`) and the app-core `newPasswordSchema` / `passwordChecks`; a test compares both settings with config.toml. The Auth server counts that length in UTF-8 bytes, not characters, so for Arabic letters or emoji it is looser (a direct API call can set a 5-character mostly Arabic password that still has a-z and 0-9); the browser counts 8 characters (code points), the owner's wording, and is deliberately stricter, so the page never sends a password the server would refuse. The checklist and the submit check use the same count. Arabic letters and Arabic-Indic digits count as neither (Supabase checks ASCII only), and passwords are never normalized. Sign-in only checks that a password was typed, so passwords chosen under the old rule keep working until they are changed. Under every new-password field: the owner's hint "8 أحرف على الأقل، مزيج من (a-z , 0-9)" / "At least 8 characters, a mix of (a-z, 0-9)", its "(a-z, 0-9)" in a left-to-right isolate (`<bdi dir="ltr">`), and a live checklist (8+ characters · Letter a-z · Number 0-9) whose items turn into a green check icon as they are met; screen readers hear only when the whole rule becomes met or unmet again. Submitting still shows the field error ("Add at least one letter and one number (a-z, 0-9)."; in Arabic the range is between LRI and PDI marks, and it never breaks across lines). A `weak_password` answer is mapped by its reasons (`length` → too short, `characters` → the mix message, `pwned` → leaked) to a message under the password field, sign-up included.
- **Why:** The owner finds 10 characters too long; requiring a letter and a digit keeps 8 characters from being trivial. "(a-z, 0-9)" instead of "English letters and numbers" is the owner's wording and shows exactly which characters count.
- **Rejected:** a rule only in the app (any other client could set a weaker password); counting Arabic letters or Arabic-Indic digits (the Auth server would refuse the password); normalizing Arabic-Indic digits in passwords (the saved password would differ from what the user typed); upper and lower case or symbols (not asked for). Details: ARCHITECTURE.md §Auth

### D-073 · 2026-09-25 · A code request answered "too soon" is sent again once; the sign-up code screen says what a registered address gets

- **Decision:** The owner's bug: codes for "Forgot password" and "Create account" did not arrive. (1) Supabase Auth emails an address at most once per `[auth.email] max_frequency` (60 s), across sign-up and sign-in codes and resets, and answers a request inside that window with 429 `over_email_send_rate_limit`. "Forgot password", "Send me a code" and every resend (sign-up, sign-in and reset codes, and the sign-up code a password sign-in sends for an unconfirmed email) still treat that answer like success (D-062), and now plan one automatic resend: after the wait the message states ("…only request this after 34 seconds.", the only auth message text the app reads, for that number only), clamped to 1–65 s, else `AUTH_RESEND_COOLDOWN_SECONDS`, plus one second (the server rounds down). `requestPasswordReset`, `requestSignInCode` and `signInWithPassword` return it as `retryAt`, and the page hands it with the pending code (sessionStorage) to `/reset` or `/verify`, whose flow sends the same request once at that time; a resend on the code screen plans its own. The retry runs only while the code screen is shown (`Flow.start`, which `useFlow` calls while the component is mounted, so leaving the page cancels it; React's double effects in development re-arm it), only while the flow is idle on the code step (a code check in progress is waited for; an accepted code drops it), and only before the countdown ends (after that the user can ask). Its own answer is never retried (a second "too soon" stays silent; no loop). A reload keeps a retry that has not run yet; the pending entry drops it once it runs, and a handed-over time more than 66 s ahead is ignored. Nothing on screen changes for it (no status, spinner, "We sent a new code" or new countdown); its result is handled like a resend (the same answers stay silent, a real problem such as a network error is shown). "Send a new code" waits until the retry plus the cooldown (`resendAvailableAt(sentAt, retryAt)`), so the user is not invited to ask in parallel; a retry that goes out on time leaves that countdown as it is (so screen readers hear nothing new), and only one held back more than 2 s (by a code check) moves it to a cooldown after the retry. (2) No retry when this tab asked for the same code: the request's `sent` is this tab's pending entry for the same purpose (the same address, sent less than a cooldown ago, no retry planned, not used). A "too soon" answer is then about that email, whose code still works, so nothing is sent again (a second email would make the first code stop working) and the usual 60-second countdown starts: pressing "Forgot password", "Send me a code" or "Create account" twice shows a registered and an unknown address the same screen. This also corrects D-062 (3): a new address signed up again within a minute is answered "too soon" (a registered one gets the silent no-op); after this tab's own sign-up code it now looks like the first sign-up. Any other rate limit on sign-up is still shown, because `resend` answers an address without an account with a silent 200, so a hidden budget error could strand a new address. (3) The sign-up code screen always shows, under "We sent a code to …", a muted note: "If this email is already registered, no code will be sent — sign in instead." / "إذا كان بريدك مسجلًا من قبل، فلن يصلك رمز. سجّل الدخول بدلًا من ذلك.", with "sign in" linking to `/login`. It replaces the "Already have an account? Sign in" footer line ("Reset your password" stays). It is shown after every sign-up, so it reveals nothing; not after a password sign-in's "Please confirm your email first", where a code was sent. The sign-in page is not prefilled: it has no safe way to receive the address (never in the URL, and the pending entry also remains after "Use a different email").
- **Why:** The owner asked for a sign-in code and then, 26 s later, a reset: the reset was answered "too soon", the screen said a code was sent, and none came. Signing up with a registered address sends nothing by design (D-062), and people wait for a code that never comes. The review showed that retrying a request this tab had just sent made the first code stop working and made the countdown longer only for registered addresses; (2) removes both.
- **Trade-offs:** the retried email replaces an earlier code of the same kind sent from elsewhere, as any resend does. When the "too soon" comes from another tab, device or kind of code (e.g. "Forgot password" and then "Send me a code", or "Create account" and then "Forgot password", within a minute), the countdown is longer (up to about two minutes) for an address that was emailed, and a sign-up from elsewhere shows "We can't send you an email right now". That is the same signal Supabase's own answer already gives any caller (D-062 (5)). Open: the owner confirms this remaining difference (ROADMAP.md §Open).
- **Rejected:** showing "try again in N seconds" (it tells a recently emailed, so registered, address apart); a spinner or notice while the retry waits; retrying more than once or in a loop; a retry that outlives the page (a service worker or the server); hiding every rate limit on sign-up (a hidden project-wide budget error would leave a new address waiting for a code no resend can bring). Details: ARCHITECTURE.md §Auth
