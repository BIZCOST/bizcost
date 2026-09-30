# BizCost — Data Model

Purpose: entities, tables, relationships and database conventions for BizCost (Postgres on Supabase).
Last updated: 2026-10-01

**Status:** the Milestone 1 tables (§4) are IMPLEMENTED (Step 1: `packages/db`, `supabase/migrations`, pgTAP in `supabase/tests`). The M2 entities of §6 are DECIDED (the owner's answers of 2026-09-28, D-111–D-120) and are built step by step in M2: materials and products & services are IMPLEMENTED (M2 Step 2, D-121–D-125); suppliers, purchases, supplier returns and credit notes, the stock ledger with its projections, the books-closed date and attachments are IMPLEMENTED (M2 Step 3, D-133–D-140); recipes (M2 Step 4) and what purchases leave owed (D-160) too; the cost categories, expenses with their payments and running costs are IMPLEMENTED (M2 Step 5, D-164–D-169); the product-cost settings (M2 Step 6, D-186) and the month an expense is for (M2 Step 7, D-194) too. Everything else is PLANNED.
Labels: **IMPLEMENTED** = built and tested. **DECIDED** = design settled, not implemented yet. **PLANNED** = future phase, shape may change. **OPEN** = decision still needed (deadline in ROADMAP.md).
Related: API, permissions engine, redaction, numbers/i18n code → ARCHITECTURE.md · modules, capabilities, roles, UI terms → PRODUCT.md · phases → ROADMAP.md · rationale → DECISIONS.md.

---

## 1. Conventions (DECIDED)

### 1.1 Schema, DB role, migrations

- All app tables live in Postgres schema `app`. `app` is NOT exposed to the Supabase Data API (PostgREST). `anon` and `authenticated` have zero grants on it.
- The API connects as role `bizcost_api`: no BYPASSRLS, not superuser, not table owner. A query without tenant context returns 0 rows (fails closed).
  - Created `NOLOGIN` in migrations. `LOGIN PASSWORD` is set per environment from a secret (ARCHITECTURE.md §Runbooks), never committed.
  - Default privileges: SELECT/INSERT/UPDATE/DELETE on `app` tables, except `audit_log` (SELECT only; the audit trigger writes it, §1.6).
  - Role settings: `statement_timeout = 15s`, `idle_in_transaction_session_timeout = 30s`, `search_path = extensions` (so `citext` operators resolve; app objects are always schema-qualified).
  - Local stack only: `supabase/seed.sql` gives it `LOGIN PASSWORD 'bizcost_local_dev'` and refuses to run anywhere else. Never run `supabase db push --include-seed` or `supabase db reset --linked`.
- Schema source of truth: Drizzle (stable 0.45.x) in `packages/db` → `drizzle-kit generate` (prefix `supabase`) into `supabase/migrations`. Hand-written SQL (role, functions, grants, policies, triggers) goes in `--custom` migrations.
- Migrations are applied only by Supabase CLI (`migration up` or `db reset` locally, `db push` from `db-migrate.yml`, manual approval for prod). Never `drizzle-kit push/migrate` on shared DBs.
- Layout (IMPLEMENTED): `app_schema` (generated) → `api_role_and_context` (custom: role, `citext`, `app.current_user_id()`/`current_business_id()`) → `m1_tables` (generated) → `tenancy_security` (custom: helper and bootstrap functions, triggers, RLS, grants) → `business_create_limit` (custom, Step 5: the daily creation limit in `app.create_business`) → `settings_columns` (generated, Step 6) → `settings_security` (custom: the bucket, members' emails, invitation limits and preview, new `create_business`/`accept_invitation`) → `settings_hardening_tables` (generated: `file_uploads`, invitation indexes) → `settings_hardening` (custom: upload registry RLS, limits and Storage guard, invitation limits per address and user, preview triggers, the inviter check, membership anonymization) → `business_name_ar_preview` (custom: `app.preview_invitation` also returns the Arabic name, D-097) → `confirmation_drops_password` (custom, Step 9: the trigger `forget_unconfirmed_password` on `auth.users` that drops a password chosen before the address was confirmed when an emailed code confirms it, D-102) → `catalog_tables` (generated, M2 Step 2: `materials`, `material_units`, `products_services`, `product_locations`) → `catalog_security` (custom: their RLS, touch and audit triggers, and the products and materials permission keys added once to the existing template roles, D-124) → `purchasing_tables` (generated, M2 Step 3: `suppliers`, `purchases`, `purchase_lines`, `purchase_returns`, `purchase_return_lines`, `stock_movements`, `material_costs`, `stock_balances`, `attachments`, `businesses.books_closed_through`, the `attachment` upload purpose) → `purchasing_security` (custom: their RLS, touch and audit triggers; the append-only ledger (`append_only`, no UPDATE/DELETE grant); `guard_posted` on documents and their lines; the attachments target check; the bucket takes PDF and 10 MB; upload limits per purpose; the suppliers and purchases keys added once to the existing template roles, D-140) → `purchasing_integrity` (custom, after the security review: the trigger `keep_dimension` on `materials` and a `check_target` that refuses a discarded purchase, D-145) → `recipes_tables` (generated, M2 Step 4: `recipes`, `recipe_lines`, `products_services.resale_material_id`) → `recipes_security` (custom: their RLS, touch and audit triggers, `keep_resale_link`, `keep_dimension` counting live recipe lines, existing retail businesses moved to the `retail` profile, the recipe keys added once to the existing template roles, D-148, D-149, D-153) → `recipes_need_materials` (custom, after the second review: the recipe keys taken off any role without `materials.items.view`, D-155) → `name_key` (custom, the owner's round of 2026-09-29: `app.name_key`, live duplicates renamed, D-158) → `purchasing_payments_tables` (generated: `purchase_payments`, `purchases.paid_by_member_id` and `prices_include_vat`, the payment method's checks, `materials_name_key` on `app.name_key(name)`) → `purchasing_payments_security` (custom: its RLS, touch and audit triggers, append-only but for its reversal, the payment keys added once to the existing template roles, D-160) → `name_key_unicode` (custom, after the security review: `app.name_key` drops format characters and normalizes to NFKC first, Persian letter forms folded, the index rebuilt, D-158) → `expenses_tables` (generated, M2 Step 5: `cost_categories`, `expenses`, `expense_payments`, `running_costs`, `businesses.expense_approval`, attachments of `expense`) → `expenses_security` (custom: their RLS, touch and audit triggers; `guard_expense` (an expense under review is frozen, a posted one only becomes reversed); payments recorded only on a posted expense that is owed, never edited, and an expense with payments not reversed; `check_target` for expenses; the starter categories of existing businesses in their language; the expenses and running-costs keys added once to existing template roles; D-164–D-169). → `recipe_yield` (generated, the owner's answers of 2026-09-29: `recipes.yield_qty`, D-178; the index `expenses_created_by_idx` for a member's own expenses, D-181) → `owners_answers_access` (custom: the Employee template's new keys added once to existing Employee roles, each only where the keys it needs are held, D-179, D-180) → `product_costs` (generated, M2 Step 6: `businesses.estimated_monthly_purchases`, `owner_hourly_rate`, `products_services.owner_minutes`, D-186) → `product_costs_access` (custom: the Cost Engine keys added once to existing template roles) → `expense_period_month` (generated then edited, M2 Step 7: `expenses.period_month` added, filled with the month of each expense's `business_date` with the row guards off for that statement, then NOT NULL, its index and range check; `cost_categories.billed_next_month`, D-194) → `costing_core_release` (custom: the starter utility categories of existing businesses marked as billed the month after; the data keys taken off any role that held only some of costs, supplier prices and margins, D-190) → `expense_period_default` (custom: the trigger `default_period_month` fills the month of a row written without it, D-194) → `expense_reversal_month` (generated then edited, after the review of M2 Step 7: `expenses.reversal_period_month`, backfilled with each reversed expense's own month with the row guards off, its check, and `guard_expense` letting it change only with the reversal, D-200) → `payments_need_prices` (custom: approving expenses and recording payments taken off any role without supplier prices, D-200) → `books_close_setting` (custom: the stored key `purchases.books.close` renamed `settings.books.close` in roles, members' own changes and pending invitations, D-201). Custom files are created with `drizzle-kit generate --custom`, so Drizzle's journal (`supabase/migrations/meta/`, ignored by the Supabase CLI) stays consistent. A later tenant table = a generated migration + a custom one that calls `app.apply_tenant_rls()` and adds the `touch_row`/`audit_row` triggers (the pgTAP catalog check fails otherwise).
- Scripts: `pnpm db:reset`, `pnpm db:test` (pgTAP + `@bizcost/db` integration tests), `pnpm --filter @bizcost/db db:generate`.
- Naming: snake_case, plural table names, FK columns `<entity>_id`. Code-defined keys (modules, capabilities, permissions, role templates) are stored as keys; their labels come from i18n.

### 1.2 Standard tenant columns — `tenantTable()`

Every business-owned table is declared with the `tenantTable()` helper, which adds:

| Column / rule              | Definition                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid` PK, UUIDv7, generated by the client (`newId()` in `domain`); no DB default. The local demo data uses stable v8 ids (D-185)                     |
| `business_id`              | `uuid NOT NULL` → `businesses(id)`                                                                                                                    |
| `UNIQUE (business_id, id)` | target of composite FKs                                                                                                                               |
| Composite FKs              | child `(business_id, x_id)` → parent `(business_id, id)`. The DB makes cross-business links impossible.                                               |
| `created_by`, `created_at` | actor UUID (§1.3, default `app.current_user_id()`) + `timestamptz`                                                                                    |
| `updated_by`, `updated_at` | same; set by the `app.touch_row()` trigger                                                                                                            |
| `deleted_at`               | `timestamptz NULL`, soft delete. Unique rules = partial indexes `WHERE deleted_at IS NULL`                                                            |
| `version`                  | `integer`, +1 by `app.touch_row()`; update `WHERE version = :expected`; mismatch → typed `CONFLICT`                                                   |
| `request_hash`             | payload fingerprint for idempotent creates                                                                                                            |
| Indexes                    | lead with `business_id`. Exceptions: global `UNIQUE (token_hash)`, `business_members (user_id)`, `business_invitations (created_by, created_at)` (§4) |
| RLS                        | `ENABLE` + `FORCE ROW LEVEL SECURITY` + the generated standard policy (ARCHITECTURE.md §RLS)                                                          |

- `app.touch_row()` (BEFORE UPDATE on `businesses` and every tenant table) also rejects changes to `id`, `business_id`, `created_by`, `created_at`.
- Idempotent create: on `id` conflict compare `business_id`, `created_by`, `request_hash`. Same → return the existing row. Different → typed `CONFLICT`. Never a bare `ON CONFLICT DO NOTHING`. IMPLEMENTED as `insertIdempotent(tx, table, values)` in `packages/db`: `ON CONFLICT (id) DO NOTHING`, then the comparison (creator = the current user); a mismatch, or an id taken in another business (invisible under RLS), throws `ConflictError`; any other unique violation still raises 23505. `createIdempotent` does the same and also says whether this call inserted the row, so a create that writes child rows (a material's units, M2 Step 2) writes them once.
- No hard deletes of business data. Disabling a module hides its data, never deletes it.

### 1.3 Actor columns and auth references

- `created_by`, `updated_by` and audit actor columns store the auth user UUID **without FK** to `auth.users` or `profiles`. Account deletion therefore never fails and never cascades into business data.
- No app table has an FK into the `auth` schema (`profiles.id` included).

### 1.4 Numbers

| Kind                                             | Type             | Examples                                |
| ------------------------------------------------ | ---------------- | --------------------------------------- |
| Money                                            | `numeric(20,4)`  | prices, line totals, VAT amounts        |
| Quantity                                         | `numeric(24,6)`  | purchase qty, recipe qty, stock         |
| Unit cost, cost per base unit, conversion factor | `numeric(28,12)` | AED 0.006 per ml; 1 carton = 12 bottles |
| Rate                                             | `numeric(9,6)`   | VAT rate, percentages, tolerances       |

- Never float/double or the Postgres `money` type. Wire format = decimal strings. Heavy aggregation in SQL.
- Storage consequence of the two rounding policies (ARCHITECTURE.md §Numbers, money, units & time): document amounts are stored rounded to the currency minor unit; cost-engine values (unit cost, recipes, WAC) are stored unrounded at `numeric(28,12)`.
- Every financial document has a `currency` column (default `businesses.currency`). Multi-currency (`fx_rate`, base-currency amounts) is PLANNED and not modelled now.

### 1.5 Time

- All instants are `timestamptz`, stored in UTC. Business timezone in `businesses.timezone` (default `Asia/Dubai`).
- Every document has `business_date date` (the local business day). Reports group by `business_date`, not by timestamp.

### 1.6 Documents, ledgers, audit

- Documents have `status` `draft` | `posted` | `reversed` (IMPLEMENTED for purchases, supplier returns and credit notes, M2 Step 3; sales, invoices… PLANNED, plus module-specific states).
- Posted = immutable (enforced by the `guard_posted` triggers: a posted document only becomes reversed, its lines never change, nothing is deleted; D-134). Correction = reversal entry + new entry. Posted lines store **cost snapshots** (the cost used at posting), so history does not shift when WAC changes.
- IMPLEMENTED (D-114, D-137): an optional per-business "books closed up to" date (`businesses.books_closed_through date NULL`), set by the Owner or an Admin (`settings.books.close`, a Settings key since M2 Step 7, with Purchases or Expenses on, D-176, D-201), never after today. Nothing dated on or before it can be posted; a reversal of a closed day is dated the first open day, and refused while that day is after today (D-135); moving it back is allowed and audited.
- Ledgers (`stock_movements`, `audit_log`) are append-only. Balances are projections that can be rebuilt.
- `audit_log` (M1, IMPLEMENTED) is written only by the trigger `app.audit_row()` (AFTER INSERT/UPDATE/DELETE on `businesses` and every tenant table), so no write can skip it and no row can be forged. `bizcost_api` may only read it. Every row records actor + `request_id`. Account rows (`profiles`) have no audit trigger: they belong to no business (D-103).

### 1.7 Bilingual text

- `businesses.legal_name` + `legal_name_ar` (IMPLEMENTED, D-097): a legal name for the trade licence and tax invoices.
- Master records have one name only (DECIDED, D-113): `name text NOT NULL`, in any language, and no `_ar`/`_en` columns, for materials, products & services, suppliers, customers, running costs and categories. Rows BizCost creates (starter categories) are written in the business's `default_locale` and are then plain data. OPEN before Invoices (Phase 3): whether tax invoices need Arabic item descriptions (ROADMAP.md §Open).

### 1.8 Files and DB tests

- Files: private Storage bucket `business-files` (migration `settings_security`: private, PNG/JPEG/WebP; from `purchasing_security` also PDF, up to 10 MB), object path `{business_id}/{entity}/{uuidv7}.{ext}`; access rules in ARCHITECTURE.md §Storage. Uses: the business logo (`businesses.logo_path`, still PNG/JPEG/WebP up to 2 MB, checked by the API) and, from M2 Step 3, attachments (§6 Files), both uploaded through the registry `file_uploads` (§4).
- DB tests (pgTAP: `catalog_coverage`, `grants`, `rls_*` with InitPlan check) and cross-tenant attack tests: ARCHITECTURE.md §Testing & CI.

---

## 2. Tenancy and RLS (IMPLEMENTED)

- Mechanism (tenant context via `withTenantTx()`, the one standard policy on every tenant table, SECURITY DEFINER hardening): ARCHITECTURE.md §Tenancy & security. This section lists only the DB objects.
- Helper functions in schema `app`: `app.current_user_id()`, `app.current_business_id()` (read the transaction-local settings), `app.is_active_member(business_id)` and `app.my_business_ids()` (STABLE SECURITY DEFINER; active, non-deleted `account` memberships of the caller). Policies call them with `app.current_business_id()`, never a row column (InitPlan). `app.apply_tenant_rls(table)` is the migration-only helper that adds ENABLE + FORCE RLS and the standard `tenant_isolation` policy.
- **Identity tables** (T = the standard tenant predicate):

| Table                  | Read                                     | Write                                                                |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `profiles`             | own row (`id = app.current_user_id()`)   | insert/update own row (upsert in `me`); no delete                    |
| `businesses`           | `id = any(array(app.my_business_ids()))` | update the current business (active member); no insert/delete policy |
| `business_members`     | T, or `user_id = app.current_user_id()`  | T (the API checks permissions)                                       |
| `business_invitations` | T                                        | T; acceptance only via `app.accept_invitation()`                     |
| `audit_log`            | T                                        | none for `bizcost_api` (trigger only)                                |

- Co-members' names and emails come from `business_members.display_name` (NOT NULL for every kind) and `business_members.email`; the API keeps both in sync with the account (D-065, D-083). Profiles stay own-row only.
- Bootstrap functions (SECURITY DEFINER): `app.create_business(id, legal_name, default_locale, owner_display_name, owner_role_id, member_id)` creates the business, its `owner` role and the caller's active membership. A user creates at most 10 businesses in 24 hours (counted from `businesses.created_by`/`created_at`, soft-deleted ones included; a transaction-level advisory lock per user makes concurrent creations count each other; over the limit SQLSTATE `BZ429`, which the API answers with `rate_limited`, D-076); `app.accept_invitation(token, member_id)` and `app.preview_invitation(token)` (§4 business_invitations); `app.anonymize_my_memberships(display_name)` (account deletion, §4 business_members).
- RLS = isolation between businesses ONLY. Roles, permissions, module gates and sensitive-field redaction are enforced in TypeScript (ARCHITECTURE.md §Permissions, modules & capabilities). Never add per-permission RLS policies.

---

## 3. Identity vs membership vs employee

| Concept                     | Table                   | Scope                   | Notes                                                                                                                     |
| --------------------------- | ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Login identity              | `auth.users` (Supabase) | global                  | email + password / email OTP. No FKs point to it.                                                                         |
| Person profile              | `app.profiles`          | global, 1 per auth user | name, locale, last business. Anonymized on account deletion.                                                              |
| Membership (access)         | `app.business_members`  | per business            | role, status, location scope. Can exist **without** an auth user (`pin_only`).                                            |
| Employee (PLANNED, Phase 5) | `app.employees`         | per business            | HR/cost master: pay, attendance, payroll, labor cost, petty cash. Optional link `employees.member_id → business_members`. |

- One person = one employee record, reused by attendance, overtime, payroll, projects, labor costing, petty cash.
- Membership ≠ employment: an owner or accountant can use the app without being an employee; an employee can have no app access. Do not put HR fields on `business_members` or access fields on `employees`.

---

## 4. Milestone 1 tables (IMPLEMENTED)

Standard columns from §1.2 are not repeated. `profiles` and `businesses` are not `tenantTable()`s (see each).

| Table                                             | Purpose                                   |
| ------------------------------------------------- | ----------------------------------------- |
| `profiles`                                        | person with a login                       |
| `businesses`                                      | tenant root; legal/tax/locale settings    |
| `business_capabilities`                           | in-screen flags from Smart Setup          |
| `business_modules`                                | which modules are on                      |
| `locations`                                       | branches/sites                            |
| `roles`, `role_permissions`                       | editable per-business roles               |
| `business_members`                                | membership + access                       |
| `member_permission_overrides`, `member_locations` | per-member allow/deny and location scope  |
| `business_invitations`                            | pending invites                           |
| `file_uploads`                                    | upload URLs issued for the private bucket |
| `setup_answers`                                   | raw Smart Setup answers                   |
| `audit_log`                                       | append-only write log                     |

### profiles

- `id uuid` PK = auth user id (no FK) · `display_name text` · `locale text` (`en` | `ar`, kept in sync with auth `user_metadata.locale` for bilingual emails) · `last_business_id uuid NULL` (post-login routing: set by Smart Setup and `account.setLastBusiness`, only to a live business where the user is an active member; `/` ignores it once that is no longer true, D-077) · `anonymized_at timestamptz NULL` · `created_at`, `updated_at`.
- Created by upsert in the `me` API procedure, not by a trigger on `auth.users`.
- On account deletion the row is anonymized (`anonymized_at`), never hard-deleted. Flow and sole-owner guard: ARCHITECTURE.md §Auth.

### businesses

Tenant root: `businesses.id` is the `business_id` used everywhere. Has `created_*`, `updated_*`, `deleted_at`, `version`.

| Column                | Type / default        | Notes                                                                                                                                       |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `legal_name`          | `text NOT NULL`       |                                                                                                                                             |
| `legal_name_ar`       | `text NULL`           | Arabic legal name (tax invoices); the Arabic app shows it instead of `legal_name` (D-097)                                                   |
| `business_type`       | `text`                | `food` / `factory` / `workshop` / `projects` / `maker` / `retail` / `services` / `other` (Smart Setup, PRODUCT.md §6.4); never a hard limit |
| `terminology_profile` | `text`                | `general` / `food` / `maker` / `workshop` / `factory` / `projects` (UI wording); `retail` from M2 Step 4 (D-117)                            |
| `country`             | `char(2)` `'AE'`      |                                                                                                                                             |
| `currency`            | `char(3)` `'AED'`     | ISO-4217                                                                                                                                    |
| `vat_registered`      | `boolean`             |                                                                                                                                             |
| `trn`                 | `text NULL`           | CHECK exactly 15 digits (`^[0-9]{15}$`)                                                                                                     |
| `timezone`            | `text` `'Asia/Dubai'` |                                                                                                                                             |
| `default_locale`      | `text`                |                                                                                                                                             |
| `plan`                | `text`                | placeholder only; no billing in M1                                                                                                          |
| `setup_completed_at`  | `timestamptz NULL`    | Smart Setup finished                                                                                                                        |
| `logo_path`           | `text NULL`           | Storage path                                                                                                                                |

- Invariant: at least one active Owner at all times. Ownership transfer is an explicit action. Enforced by the DEFERRABLE INITIALLY DEFERRED constraint trigger `app.enforce_active_owner()` on `business_members`, on `roles` (`template_key`/`deleted_at` changes) and on `businesses` (restore): at commit, a live business needs an active, non-deleted `account` member whose role has `template_key = 'owner'`. Soft-deleted businesses are exempt. If two transactions remove the last two owners, one commit fails with 23514 (40001 in REPEATABLE READ/SERIALIZABLE; the API retries 40001).
- CHECKs: `trn` (above), `default_locale in ('en','ar')`.
- Business deletion + data export: semantics documented in M1, no UI. Model supports it: every row keyed by `business_id`, every file under `{business_id}/`.
- Deleting an account soft-deletes (`deleted_at`) every business whose only member is that user, after locking the business row (`FOR UPDATE`: adding a member takes a key-share lock on it); the user's memberships become `removed` with display name 'Deleted user' (D-064).

### business_capabilities

- `key text` from the code capability registry (`packages/modules`). Examples: team vs solo, multi-location, `vat_registered`, keeps stock, uses machines, sells via POS, jobs & tasks. Final keys live in the registry; user meaning in PRODUCT.md.
- `enabled boolean` · `value jsonb NULL` (only for non-boolean capabilities) · `source text` (`setup` | `user`). Smart Setup writes one row per stored capability; `user` where the review changed the recommended value.
- `UNIQUE (business_id, key)`.
- Capabilities hide fields/sections/pickers inside screens. Changing one never migrates data.
- Single source of truth: a capability that mirrors a business column is read from that column, not stored twice. `vat_registered` lives only in `businesses` (CHECK `key <> 'vat_registered'`).

### business_modules

- `module_key text` (code manifest key) · `enabled boolean` · `enabled_at timestamptz` · `enabled_by uuid` (no FK).
- `UNIQUE (business_id, module_key)`.
- Availability (`released` | `planned`) lives in code manifests, not in the DB. Setup may enable a planned module; it appears only after release. Disabling hides; data is kept.
- No row = the default: core modules on, optional modules off. A row switches a module on or off; Dashboard and Settings are always on and their rows are ignored (D-059). Smart Setup writes `enabled = false` rows for the core modules a business does not use.

### locations

- `name text` · `is_default boolean` (partial unique: one default per business). Smart Setup creates the default location.
- Single-location businesses never see a location picker (capability).

### roles / role_permissions

- `roles`: `name text` · `template_key text NULL` (NULL = custom role). Copied from code role templates (template list: PRODUCT.md §8 Roles & permissions); fully editable. `app.create_business()` creates only the `owner` role; Smart Setup (Step 5) adds the other templates and the default location. The `owner` template has every permission implicitly, so it has no `role_permissions` rows.
- `role_permissions`: `role_id` (composite FK) · `permission_key text` (`module.resource.action`, from the code permission catalog). `UNIQUE (business_id, role_id, permission_key)`. Row present = granted.

### business_members

| Column                | Type          | Notes                                                                                                                 |
| --------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `user_id`             | `uuid NULL`   | auth user id, no FK. NULL for `pin_only` (staff without email)                                                        |
| `kind`                | `text`        | `account` \| `pin_only`                                                                                               |
| `display_name`        | `text`        | NOT NULL for every kind; the name co-members see in this business                                                     |
| `status`              | `text`        | `invited` \| `active` \| `suspended` \| `removed`                                                                     |
| `role_id`             | `uuid`        | composite FK → `roles`                                                                                                |
| `permissions_version` | `integer`     | bumped whenever the member's effective permissions change; sent in a response header so clients refetch `me`          |
| `pin_hash`            | `text NULL`   | RESERVED. PIN login on a shared branch device is NOT built in M1                                                      |
| `email`               | `citext NULL` | the account's verified email (members list, "already a member" check); NULL for `pin_only` and after account deletion |

- `UNIQUE (business_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL`. CHECK: `(kind = 'pin_only') = (user_id IS NULL)`, plus the `kind` and `status` value lists.
- Index `(user_id) WHERE user_id IS NOT NULL` (not led by `business_id`): serves the own-memberships read policy and `app.my_business_ids()` (business switcher) without scanning every business's members.
- `pin_hash` is never copied into `audit_log`.
- Membership is checked in the DB on every request, so remove/suspend takes effect on the member's next request.
- `email` (Step 6, D-083) is set by `app.create_business` and `app.accept_invitation` from the verified auth email (existing members were filled once by the migration), and copied again by `me` when the account's email changed. Account deletion clears it, with the display name, on every membership of the user, removed ones included: `app.anonymize_my_memberships(display_name)` (SECURITY DEFINER; only for the caller's own memberships, and only once their profile is anonymized).

### member_permission_overrides / member_locations

- `member_permission_overrides`: `member_id` · `permission_key` · `effect` (`allow` | `deny`). `UNIQUE (business_id, member_id, permission_key)`.
- `member_locations`: `member_id` · `location_id` (both composite FKs). `UNIQUE (business_id, member_id, location_id)`.
- Resolved by the domain engine (`resolveEffective`, `can`), fully tested in M1, then `withNeededKeys` (`@bizcost/modules`): a key that misses a key it needs grants nothing (D-190). A member's overrides are read and saved whole by `member.permissions` / `member.updatePermissions` (M2 Step 7, D-191): only how the member differs from their role is stored (an allow of a key the role lacks, a deny of one it grants); they stay when the member's role changes. The location-scope screen waits for a module used per branch.
- An empty location set means **all** locations of the business, including ones added later; a non-empty set limits the member to those locations (D-054).

### business_invitations

| Column                                       | Type                     | Notes                                                       |
| -------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `email`                                      | `citext`                 |                                                             |
| `token_hash`                                 | `text`                   | only the hash is stored; raw token only in the email        |
| `expires_at`                                 | `timestamptz`            |                                                             |
| `status`                                     | `text`                   | `pending` \| `accepted` \| `revoked` \| `expired`           |
| `role_id`                                    | `uuid`                   | composite FK → `roles`                                      |
| `overrides`                                  | `jsonb`                  | allow/deny set applied on acceptance                        |
| `location_ids`                               | `uuid[]`                 | validated on acceptance (arrays have no FK)                 |
| `send_count`, `last_sent_at`                 | `integer`, `timestamptz` | rate-limit counters                                         |
| `locale`                                     | `text`                   | `en` \| `ar`: the email's language (a resend uses it again) |
| `preview_count`, `preview_window_started_at` | `integer`, `timestamptz` | previews of the link in the current hour                    |

- Limits counted in the DB by the trigger `app.invitation_limits()` (no external service; a transaction-level advisory lock per business; SQLSTATE `BZ429`): 20 invitations per business and 40 per inviting user (`created_by`, in all businesses) in 24 hours, revoked ones included; `send_count` ≤ 4 (3 resends) and never goes down; 4 emails per `(business_id, lower(email))` in 24 hours (the `send_count` of every invitation of that address last sent within 24 hours). Indexes `(business_id, lower(email))` and `(created_by, created_at)` serve the counts. Every write is audited, except that an update of only the two preview columns neither touches the row nor writes `audit_log` (conditional triggers).
- One `pending` invitation per `(business_id, lower(email))` (partial unique index). `token_hash` = SHA-256 hex, `UNIQUE` across all businesses (acceptance looks it up before the business is known); never copied into `audit_log`.
- `overrides` = `{permission_key: 'allow' | 'deny'}`.
- Acceptance via `app.accept_invitation(token, member_id)`: the caller's **verified** email (`auth.users.email_confirmed_at`) must equal the invitation email (case-insensitive); the business must be live; the role must still exist and not be the Owner role; the locations must still exist; and the sender (`created_by`) must still be an active `account` member who may invite (the owner, or `settings.members.manage` from the role or an allow override, without a deny override). Every such failure raises the same `invitation_invalid` (`BZ404`); an already active member gets `already_member` (`BZ409`). It creates or re-activates the `account` membership (display name from the profile, else the email's local part; the verified email), replaces the member's overrides and locations with the invitation's, and sets `accepted`. Rows it creates get ids from `app.uuid_v7()`.
- Preview via `app.preview_invitation(token)` (works signed out): the business's legal and Arabic names, inviter name, role name and template key, the email masked, expiry, and whether a signed-in caller's verified email matches. Only a pending invitation of a live business is shown (expired ones as expired); anything else is `invitation_invalid`. At most 30 previews per invitation an hour (`BZ429`).
- The API revokes pending invitations whose sender left, was removed or may no longer send them (ARCHITECTURE.md §API, Step 6).

### file_uploads

Every signed upload URL the API issues for the bucket `business-files` (Step 6, D-085). A tenant table (standard columns, RLS, touch and audit triggers).

| Column         | Type          | Notes                                                                                                              |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `path`         | `text`        | `{business_id}/{purpose}/{uuidv7}.{ext}`; CHECK: starts with the row's `business_id`; `UNIQUE (business_id, path)` |
| `purpose`      | `text`        | `logo` (M1) \| `attachment` (M2 Step 3)                                                                            |
| `content_type` | `text`        | the type the URL was issued for                                                                                    |
| `expires_at`   | `timestamptz` | when the upload URL stops working (2 hours, Storage's lifetime)                                                    |
| `status`       | `text`        | `issued` \| `used` (saved) \| `discarded` (refused, replaced, removed or expired unused)                           |

- At most 10 logo and 100 attachment uploads per business in an hour, each purpose counted on its own (trigger `app.file_upload_limits()`, advisory lock per business, `BZ429`).
- The trigger `guard_business_file` on `storage.objects` (function `app.guard_business_file()`, SECURITY DEFINER) refuses (42501) any object of `business-files` whose path is not an `issued`, unexpired row, on insert and on a change of name, bucket or version.

### setup_answers

- `question_set_version` · `answers jsonb` (the normalized answers, e.g. PRODUCT.md §6.11) · `request_hash` (SHA-256 of the canonical `createFromSetup` payload: a retry with the same business id and payload returns the business, another payload is CONFLICT, D-076). One row per business.
- Raw record of what the user answered. On confirmation the derived state is written to its own tables (`businesses.business_type`, `terminology_profile`, `business_capabilities`, `business_modules`, default location, roles). Runtime code reads those tables, not `setup_answers`.

### audit_log

- Columns: `id` · `business_id` · `actor_user_id uuid` (no FK) · `action` (`insert` | `update` | `delete`) · `entity` (table name) · `entity_id` · `request_id` · `changes jsonb` (`{before, after}`; no `before` on insert, no `after` on delete) · `created_at`. No `updated_*`, `deleted_at`, `version`.
- Written only by `app.audit_row()` (§1.6), with `id = app.uuid_v7()` and the actor and `request_id` from the tenant context. `bizcost_api` has SELECT only; standard tenant RLS for reads.
- `changes` can contain sensitive values: any read path must pass through redaction. Audit viewer UI is not in M1.

---

## 5. M1 relationships

```
auth.users ┄┄ id (no FK) ┄┄► profiles
    ┆
    ┆ user_id (no FK; NULL when kind = pin_only)
    ▼
business_members >──────────── businesses  (tenant root)
  │ role_id ──► roles             ├──< locations
  ├──< member_permission_overrides├──< roles ──< role_permissions
  └──< member_locations ──► locations
                                  ├──< business_capabilities
                                  ├──< business_modules
                                  ├──< business_invitations ──► roles
                                  ├──< setup_answers
                                  └──< audit_log
```

`──<` one-to-many via composite FK on `(business_id, …)` · `┄┄` logical link without FK.

---

## 6. Future entity map (PLANNED)

Table names are indicative. Authoritative phase per area: ROADMAP.md. Every entity below is a `tenantTable()`.

- **Names (all master tables below)** — one `name text NOT NULL` in any language; no `_ar` column (D-113, §1.7).
- **Suppliers (P2) and customers (P3, tentative)** — DECIDED (D-112): two separate tables, `suppliers` (IMPLEMENTED, M2 Step 3, D-133) and `customers` (Phase 3). One row per real supplier in `suppliers` (reused by purchases, returns and credit notes, expenses, materials) and one per real customer in `customers` (orders, projects, quotations, invoices, payments). A company that is both has one row in each, with no link; a later "copy from supplier" helper would copy fields, not link them. A payment (P3) references a customer or a supplier.
  - `suppliers` (IMPLEMENTED): `name text` (1–100 characters, one per business ignoring case among rows not deleted, archived ones included: `suppliers_name_key`; cleaned like catalog names, D-131) · `phone text NULL` (≤ 30) · `email text NULL` (≤ 254) · `trn text NULL` (15 digits, as `businesses.trn`) · `notes text NULL` (≤ 1000) · `archived_at timestamptz NULL` (archived, never deleted). Nothing on it is sensitive.
- **Products & services (P2)** — IMPLEMENTED (M2 Step 2; D-113, D-121, D-123). Document lines copy values; editing a line never edits the master.
  - `products_services`: `name text` (1–100 characters, one per business ignoring case among rows not deleted, archived ones included: unique index `products_services_name_key` on `(business_id, lower(name))`; the API stores names without invisible characters and with something to see, D-131) · `description text NULL` (≤ 1000) · `type` `product` | `service` · `unit` (a standard unit code it is sold by: piece, kg, h…) · `default_price numeric(20,4) NULL` (≥ 0; NULL = not set yet) · `vat_category` `standard` | `zero_rated` | `exempt` (default `standard`) · `price_includes_vat boolean` (default false) · `archived_at timestamptz NULL` (archived: hidden from pickers, never deleted). The VAT columns matter only while the business is VAT-registered (D-121).
  - `product_locations`: `product_id` (composite FK → `products_services`) · `location_id` (composite FK → `locations`); `UNIQUE (business_id, product_id, location_id)`. Where it is sold, only with `multi_location`: no live row = every location, as D-054. A link taken out is soft-deleted and comes back on the same row. Removing a location soft-deletes its links in the same transaction, and a location that is the only one of a product (archived ones included) cannot be removed; only members with `settings.locations.manage` change the list (D-129).
  - `resale_material_id uuid NULL` (IMPLEMENTED, M2 Step 4; D-117, D-153): composite FK → `materials`, unique per business when set (`products_services_resale_material_key`), only on a product (CHECK `products_services_resale_check`), and it never changes (trigger `keep_resale_link`, 23514). "Bought ready to sell" creates the product and its material in one transaction; the API keeps their name, unit and archiving in step (the product's row locked first, then the material's). The product's unit is the material's, and its cost is the material's average for one unit sold; it has no recipe.
  - `owner_minutes numeric(24,6) NULL` (IMPLEMENTED, M2 Step 6; D-119, D-186): the owner's minutes for one unit (> 0), used only while `has_team` is off (sensitive `cost`).
- **Units (P2)** — IMPLEMENTED in code (`domain/units`, D-108): dimensions mass, volume, count, length, area, time; standard conversions in code; cross-dimension only via an explicit factor. The CHECKs of the catalog tables list the same unit codes.
- **Materials (P2)** — IMPLEMENTED (M2 Step 2; D-108, D-113, D-122, D-123). Chain: purchase unit → packs → base unit → cost per base unit. Material cost is never typed into a recipe.
  - `materials`: `name text` (1–100 characters, one per business as people read it, archived ones included: unique index `materials_name_key` on `(business_id, app.name_key(name))`, the key of `nameKey` in `@bizcost/domain`: format characters dropped, NFKC, case, Arabic letter forms, marks and digits folded; the name is stored as typed, D-158) · `dimension` (mass | volume | count | length | area | time: quantities and costs are kept per base unit of it) · `unit` (the standard unit the business counts it in, of that dimension: CHECK on the pair) · `archived_at timestamptz NULL`. Its dimension never changes once it has stock movements or a live recipe line names it (trigger `keep_dimension`, SQLSTATE `BZ423`, D-145, D-148); the API also refuses it while a purchase names it (MATERIAL_IN_USE, D-134).
  - `material_units` (the packs and cross factors; `material_pack_conversions` in the plan): `material_id` (composite FK → `materials`) · `kind` `pack` | `cross` · `name text NULL` (packs only, ≤ 50) · `unit NULL` (cross factors only: a standard unit of another dimension) · `qty numeric(28,12)` > 0 · `of_unit NULL` (a standard unit) · `of_pack_id uuid NULL` (packs only: another pack; composite FK `(business_id, material_id, of_pack_id)` → `material_units (business_id, material_id, id)`, so a chain never leaves its material). Exactly one of `of_unit`/`of_pack_id`. "1 carton = 12 bottles" is a pack row with `of_pack_id` = the bottle; "1 l = 920 g" a cross row. The whole set is checked by the domain (`validateMaterialUnits`: chains end at a standard unit, no loops, one cross factor per dimension, and one of every pack or cross unit is a quantity `numeric(24,6)` can hold in base units, D-130) and by the API (unique ids and pack names) on every save of the material; a unit taken out is soft-deleted.
- **Purchases (P2)** — IMPLEMENTED (M2 Step 3; D-114, D-134, D-135). Purchase orders: later (purchases are direct in M2); an optional project: Phase 5.
  - `purchases`: `supplier_id NULL` (composite FK → `suppliers`) · `location_id` (composite FK → `locations`; the default location unless `multi_location`) · `business_date date` · `document_type` `tax_invoice` | `non_tax_invoice` | `no_invoice` · `reference text NULL` (≤ 100) · `payment_method NULL` `cash` | `card` | `bank_transfer` | `cheque` | `supplier_credit` | `paid_by_member` | `other` (required by the API on every save and posting from 2026-09-29; NULL only on purchases finalized before, D-159; `supplier_credit` needs `supplier_id`: CHECK `purchases_supplier_credit_check`) · `paid_by_member_id NULL` (composite FK → `business_members`; set exactly with `paid_by_member`: CHECK `purchases_paid_by_member_check`) · `prices_include_vat boolean` (default false: the prices were typed before VAT; stored amounts are before VAT either way, D-157) · `vat_not_reclaimable boolean` · `currency char(3)` · `discount_percent numeric(9,6) NULL` or `discount_amount numeric(20,4) NULL` (at most one) · `notes` · `status` `draft` | `posted` | `reversed` · totals `subtotal`, `document_discount`, `discount_total`, `net_total`, `vat_total`, `total` (`numeric(20,4)`, computed by the API on every save of a draft, frozen at posting) · at posting `vat_in_cost boolean`, `cost_total numeric(20,4)`, `posted_at`, `posted_by` · at reversal `reversed_at`, `reversed_by`, `reversal_date` · `copied_from_id NULL` (the reversed purchase a "correct" copy replaces). CHECKs keep the posting and reversal columns set exactly with their status.
  - `purchase_lines`: `purchase_id` · `position` · `kind` `material` | `delivery` · `material_id` (material lines only) · `description` (the material's name when saved, or the delivery's text) · `qty numeric(24,6)` > 0 (delivery: 1) · `unit` (a standard unit) or `pack_id` (composite FK `(business_id, material_id, pack_id)` → `material_units`: a pack of the line's own material) · `unit_price numeric(20,4)` (delivery: its amount) · `discount_percent` or `discount_amount` · `vat_rate numeric(9,6)` · amounts `subtotal`, `discount`, `net`, `document_discount`, `taxable`, `vat`, `total` (`numeric(20,4)`) · at posting `base_qty numeric(24,6)`, `delivery_share`, `cost` (what the goods cost: the receipt's value). `UNIQUE (business_id, purchase_id, id)` is the target of return lines.
  - Supplier returns and credit notes (IMPLEMENTED, D-120, D-136): `purchase_returns` (`purchase_id` · `kind` `return` | `credit_note` · `status` · its own `business_date` (not before its purchase's) · `reference` · `notes` · `currency` · `split_amount NULL` (a credit note entered as one amount) · `net_total`, `vat_total`, `total` · at posting `cost_total numeric(28,12)` and the posting and reversal columns of purchases) + `purchase_return_lines` (`return_id` and `purchase_line_id`, both by composite FKs through `purchase_id`, so a line names a line of its own return's purchase · `qty` (a return, in the purchase line's unit) or `amount` (a credit note, before VAT) · `net`, `vat` · at posting `base_qty`, `cost numeric(28,12)`; one live line per purchase line). A credit's `amount` and `split_amount` have at most the currency's minor-unit decimals, and a split is shared by largest remainder (D-142). A return or credit note is reversed only while no later return of the same purchase line stands (HAS_LATER_RETURNS, D-142). Sensitive: `supplier_price` (every price and amount; D-140).
  - Attachments: a purchase's receipts (§ Files below).
- **Business costing settings (P2)** — columns on `businesses`: `books_closed_through date NULL` (IMPLEMENTED, D-114, D-137), `estimated_monthly_purchases numeric(20,4) NULL` (IMPLEMENTED, M2 Step 6, D-116, D-186; > 0; sensitive `supplier_price`), `owner_hourly_rate numeric(20,4) NULL` (IMPLEMENTED, M2 Step 6, D-119; > 0; sensitive `cost`). Product costs are not stored: they are worked out on read (D-186). `first_stock_count_at timestamptz NULL` (D-115) comes with stock counts (P4).
- **Inventory ledger** — IMPLEMENTED for purchases, returns and credit notes (M2 Step 3, D-135); usage/production/sales consumption out, waste and count adjustments (Phase 3–4) and stock counts (P4) PLANNED. Ledger shape and lock order: D-110, D-135; the rules the owner sees: D-114, D-115, D-120.
  - `purchase_payments` (IMPLEMENTED, D-160): what the business paid of what it owed on a final purchase bought on credit or paid by a member · `purchase_id` (composite FK) · `business_date` · `method` `cash` | `card` | `bank_transfer` | `cheque` · `amount numeric(20,4)` (> 0, the currency's minor unit) · `currency char(3)` · `note text NULL` (≤ 500) · `request_hash` (idempotent record) · at reversal `reversed_at`, `reversed_by`, `reversal_date` (set together, once). Never updated otherwise or deleted (a trigger); a purchase with payments that stand is not reversed. What is owed = total − final returns and credit notes − payments that stand, never below 0; what was paid beyond it is shown, not stored (D-162). Sensitive: `supplier_price`.
  - `stock_movements` (append-only: SELECT and INSERT for `bizcost_api`, the `append_only` trigger refuses UPDATE and DELETE by anyone): `seq bigint` (identity: the posting order) · `business_date` · `location_id` · `material_id` · `kind` `purchase` (in) | `purchase_return` (quantity and value out) | `purchase_credit` (value only) | `reversal` · `qty numeric(24,6)` (signed base quantity) · `value`, `adjustment`, `unit_cost numeric(28,12)` (value after = value before + value − adjustment, D-109) · `purchase_line_id` · `return_line_id` · `receipt_id` (a return's or credit's purchase movement) · `reverses_id` (the movement a reversal undoes). A CHECK fixes each kind's shape; unique partial indexes: one `purchase` movement per purchase line, one per return or credit line, one reversal per movement. Indexes `(business_id, material_id, seq)` (replays) and `(business_id, material_id, business_date)` (the 90-day average).
  - `material_costs` (projection, one row per material for the whole business, D-006): `qty`, `value`, `avg_cost NULL` (before the first receipt that stands), `last_seq`. `stock_balances` (projection): `qty` per (location, material). Both are written in the posting's transaction, and a replay of the ledger (`replayWac`) equals them.
- **Weighted average cost (owner decision)** — exactly ONE WAC per (business, material), not per location. Updated by each posted purchase, return and credit note; perpetual, in posting order; row locks in a fixed order (D-110). Engine: `domain/costing/wac.ts` (D-109, D-136). Stock quantities are per location, the cost per business (D-114). Until the business's first stock count, the average used is the average of the last 90 days of purchases (D-115): computed on read from the ledger's purchase rows (an index on material and `business_date`; `material.costs`, D-138), while the stock-based cost row is kept from day one, so the switch needs no rebuild.
- **Recipes / BOM (P2)** — IMPLEMENTED (M2 Step 4; D-146–D-151, D-156; its yield D-178). One structure for a recipe, a bill of materials and "what you use" (the screens word it by the terminology profile: food "Recipe", retail "Items used", otherwise "Materials used"), for a product or a service. Items bought ready to sell have none (D-117).
  - `recipes`: `product_id` (composite FK → `products_services`, `UNIQUE (business_id, product_id)`): made by the first save; its `version` is the recipe's own (a save names it, CONFLICT otherwise), apart from the product's; a save that changes no line writes nothing (D-156) · `yield_qty numeric(24,6) NOT NULL DEFAULT 1` > 0: how many of the product's `unit` the recipe makes («الوصفة تكفي: 12 قطعة»; D-178), saved, versioned and audited with the recipe.
  - `recipe_lines`: `recipe_id` (composite FK → `recipes`) · `position` · `material_id` (composite FK → `materials`) · `qty numeric(24,6)` > 0 as typed, in `unit` (a standard unit of the material's dimension, or of another one through its cross factor) or `pack_id` (composite FK `(business_id, material_id, pack_id)` → `material_units`: a pack of the line's own material); exactly one of the two · `base_qty numeric(24,6)` > 0 (the same in the material's base unit, worked out by the units engine when saved and again whenever the material's units change, D-148, D-151). What the whole recipe uses, for its `yield_qty` (with the default 1: what ONE unit of the product uses). One live line per material (partial unique index `recipe_lines_material_key`); lines taken out are soft-deleted.
  - Cost is never stored: each line costs `base_qty` × the material's average (the D-115 basis: Σ value ÷ Σ base quantity of the purchases it counts), one division rounded once to 12 decimals, and the total is their exact sum, computed on read (`recipe.get`, `product.costs`, D-147); one unit sold costs total ÷ `yield_qty`, one more division rounded once to 12 decimals (`perUnit`, D-178); a cost per unit that does not fit `numeric(28,12)` is null with `tooLarge`, and a save whose new yield would make it so is VALIDATION (D-184). A material never bought has no price (null, never 0), and the total says it is incomplete. Sensitive `cost`.
- **Sales (P3)** — one sales model for manual entry, CSV import and future POS/API (`source`). Daily per-product totals allowed; no per-customer invoice needed.
- **Orders (P3)** — `orders` + lines: customer, items, qty, price, discount, payment, status, notes. Delivery per order: needed?, area, actual delivery cost, amount charged → delivery margin.
- **Cost categories (P2)** — IMPLEMENTED (M2 Step 5; D-116, D-167): `cost_categories` (`name` 1–100, one per business the way people read it: unique index `cost_categories_name_key` on `(business_id, app.name_key(name))` of live rows, archived ones included · `archived_at` · `billed_next_month boolean` (default false: its bills usually come the month after the month they are for; the starter electricity, water, internet and phone are marked, D-194)), one list for expenses and running costs, never deleted. Each business starts with the owner's 14 (`STARTER_COST_CATEGORIES`), named in its language by Smart Setup (existing businesses by the migration), then plain data.
- **Expenses (P2)** — IMPLEMENTED (M2 Step 5; D-114, D-164–D-166, D-168): `expenses`: `category_id` (composite FK → `cost_categories`) · `supplier_id NULL` · `location_id` (the default unless `multi_location`) · `business_date` (the bill's date) · `period_month date` NOT NULL (the month the bill is for, its first day: from 12 months before the bill's month to 1 month after it, CHECK `expenses_period_month_check`; index `expenses_period_month_idx`; a row written without it gets its bill's month, trigger `default_period_month`; real profit (Phase 3) counts the expense in this month; D-194) · `document_type` (tax invoice / non-tax invoice / no invoice) independent of `payment_method` NOT NULL (the purchase's seven; `supplier_credit` needs the supplier, `paid_by_member` pairs with `paid_by_member_id`: CHECKs) · `reference`, `description` (≤ 200), `notes` · `prices_include_vat`, `vat_not_reclaimable` · `currency` · `amount numeric(20,4)` > 0 as typed and `vat_rate` · `net_total`, `vat_total`, `total` (computed on every save, total = net + VAT: CHECK) · `status` `draft` | `submitted` | `approved` | `rejected` | `posted` | `reversed` · review columns `submitted_at/by`, `approved_at/by`, `rejected_at/by`, `rejection_reason` · at posting `vat_in_cost`, `cost_total`, `posted_at/by` · at reversal `reversed_at/by`, `reversal_date`, `reversal_period_month date NULL` (the month the reversal counts in: the expense's own month, or the first open month when the books were closed through the end of it; set only on a reversed expense and never before `period_month`, CHECK `expenses_reversal_period_month_check`; null: the own month; D-200) · `copied_from_id`. An expense for a month the books are closed through (to its last day) is never sent for approval or finalized (the API, D-200). The trigger `guard_expense` freezes a submitted or approved expense (only its review and posting columns change) and lets a posted one only become reversed; nothing is deleted. Posting clears any rejection (D-175). Never touches stock. Receipts: attachments with `entity` `expense`, not added or removed while the expense is submitted or approved (the API, D-176). `expense_payments`: as `purchase_payments` with `expense_id` (a posted expense that is owed; never edited or deleted; an expense with payments that stand is not reversed). `businesses.expense_approval boolean` (default false; applies only with `has_team`). Sensitive: `supplier_price` (every amount; D-165), except for the member who entered it or paid it themselves (D-181: index `expenses_created_by_idx` on `(business_id, created_by)`, with `expenses_paid_by_member_idx`, finds a member's own).
- **Running costs (P2)** — IMPLEMENTED (M2 Step 5; D-116, D-169): `running_costs` (`name` 1–100 · `category_id` (composite FK → `cost_categories`) · `amount numeric(20,4)` > 0 · `frequency` `weekly` | `monthly` (default) | `quarterly` | `yearly` · `starts_on` · `ends_on NULL` (≥ `starts_on`; the day it stopped: it counts up to the day before, D-176) · `notes`); soft-deleted when entered by mistake. Its monthly amount (amount × periods a year ÷ 12, 12 decimals) and the monthly total of those active on a day are worked out on read (`monthlyAmount`, `monthlyTotal` in `@bizcost/domain`). Sensitive: `cost` (D-165). No stored allocation rows: a product's share = its material cost × (monthly running costs ÷ monthly material purchases), computed on read; monthly purchases = the average of the last 3 full calendar months of posted purchases, or `businesses.estimated_monthly_purchases` until 3 full calendar months have passed after the month of the first posted purchase and each of the 3 months holds a posted purchase (D-186). With no running cost ever entered (removed ones aside), the share is "not entered yet", never 0. By working time to products, jobs and projects: Phase 5.
- **Quotations & invoices (P3)** — documents + lines + revisions/history. UAE tax invoice: gapless numbering per business per document type (Postgres sequences are not gapless), seller TRN, Arabic text. Line: description, qty, unit, unit price, subtotal, discount (% or fixed, applied before VAT), VAT, total. Quote → invoice, progress invoices, variations, signed-PDF upload. E-invoicing provider (ASP, Peppol PINT-AE) fields added later; re-verify rules before building.
- **Payments (P3, tentative)** — linked to the customer/supplier and the documents they settle.
- **Equipment & vehicles (P5)** — purchase cost, useful life, maintenance, electricity, machine hours → machine cost per hour.
- **People (P5)** — `employees` (§3), attendance, overtime, payroll, advances, deductions, petty cash custody (issued amount → outstanding balance → expenses/receipts/cash return → reconciled).
- **Projects, jobs & tasks (P5)** — reuse master data (customer, employees, purchases, expenses, petty cash, documents, payments). Jobs & Tasks = cost/profit per job (materials, labor time, machine time), not project management. OPEN: shared vs separate structure.
- **Usage variance & alerts (P4)** — actual = opening + purchases − closing; expected = sales/production × recipe qty; variance × WAC = unexplained cost. Reason codes use neutral wording (see PRODUCT.md); configurable tolerance.
- **VAT Center (P5)** — preparation & review over posted document VAT; separate from profitability.
- **Files / attachments** — IMPLEMENTED for purchases (M2 Step 3, D-139): `attachments` (`entity` (`purchase`; more kinds of record later, including document lines) · `entity_id` (not a foreign key: the trigger `check_target` checks it is a live record of the same business, locking it FOR SHARE, and an attachment never moves; D-145) · `path` (`{business_id}/{entity}/{uuidv7}.{ext}`, `UNIQUE (business_id, path)`) · `file_name` (≤ 200, as uploaded) · `content_type` (PNG, JPEG, WebP or PDF) · `size_bytes`). Uploaded through `file_uploads` (purpose `attachment`); at most 20 per record; removing one soft-deletes the row and removes the object.
- **AI extraction (P6)** — creates drafts only; a human confirms before posting.

### Single-source-of-truth sketch (PLANNED)

```
suppliers ──< purchases ──< purchase_lines ──► materials ──< material_units
    └──< expenses              │                  │   base unit ─► units registry
                               ▼                  │
                        stock_movements ──► stock_balances
                        (append-only)             │
                                            WAC: 1 per (business, material)
                                                  │
products_services ──< recipes ──< recipe_lines ───┘
   ├──< sale_lines ──► sales (manual | CSV | POS)
   ├──< order_lines ──► orders ──────────────┐
   └──< quotation/invoice lines ──► quotations/invoices ──► customers ◄── payments
                                                    ▲
projects/jobs ──► customers; consume materials, employees (labor),
                  equipment (machine time), expenses, running-cost allocations
employees ┄┄ member_id (optional) ┄┄► business_members

purchases ──< purchase_returns (returns, credit notes) ──► purchase_lines; they post to stock_movements
expenses, running_costs ──► cost_categories (one shared list)
products_services ── resale_material_id ──► materials (bought ready to sell: one item, two linked rows)
payments ──► a customer or a supplier (two separate lists)
```

---

## 7. Not in M1 (data layer)

- Any costing/operational table from §6.
- `idempotency_keys` table for updates, outbox/pgmq, background jobs.
- Gapless numbering, `fx_rate`, tax invoices, VAT Center.
- Offline sync schema (offline mode is not required).
