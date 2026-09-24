# BizCost — working agreement for Claude Code

BizCost is a multi-tenant SaaS for cost intelligence, profit intelligence and usage/waste monitoring (one app for every business type, English + Arabic, RTL/LTR). Web = Next.js, mobile = Expo, backend = tRPC in Next.js + Supabase (Postgres/Auth/Storage).

## Communication

- The owner writes in Arabic. Reply in Arabic — Modern Standard Arabic or Emirati dialect (not Levantine). Keep replies concise.
- Code, identifiers, commit messages and everything in `docs/` are in English.

## Context lives in `docs/` — read only what the task needs

- `docs/PRODUCT.md` — what/why, product rules, Smart Setup, modules + capabilities, UI terminology.
- `docs/ARCHITECTURE.md` — stack, repo layout, API/auth/tenancy/permissions, i18n/RTL, environments.
- `docs/DATA_MODEL.md` — tables, relationships, DB conventions.
- `docs/ROADMAP.md` — phases, current milestone, step status. Update status when a step is done.
- `docs/DECISIONS.md` — decision log. Add an entry for every new important product/technical decision.
- `docs/mockups/` — the owner's visual references.

## How we work

- Milestone by milestone. The owner must approve ("Proceed" / "ابدأ") before each milestone starts.
- Never build future phases early. No placeholder screens: only released modules appear in navigation.
- No speculative features or boilerplate. Reuse existing components/helpers before creating new ones.
- Ask only when a missing decision would cause significant rework; otherwise pick the documented default.
- Report changed files instead of pasting them. Don't rewrite unchanged files.

## Non-negotiable rules

- Tenant isolation: every tenant table has `business_id` + FORCE RLS; data access only through `withTenantTx`. See ARCHITECTURE.md.
- Permissions, module gates and hiding of sensitive fields (cost, profit, payroll…) are enforced on the server, never only in the UI.
- Money/quantities: Postgres `numeric` + decimal strings + decimal.js. Never JS floats (`parseFloat`, `toFixed` are lint errors).
- RTL: logical styles only (`ms-/me-/ps-/pe-/start-/end-/text-start`, RN `marginStart`…). Physical ones are lint errors.
- Every user-facing string goes through i18n keys (en + ar). Simple, non-accounting wording.
- Package boundaries are enforced by ESLint (`packages/config/eslint`). Pure packages (`domain`, `contracts`, `modules`, `i18n`, `tokens`) have no UI/framework/DB imports.
- Never commit secrets. `.env.example` lists variable names only.

## Commands (Windows, PowerShell; Node 24, pnpm 10)

- `pnpm install` — install workspace deps.
- `pnpm check` — typecheck + lint + test (all packages, via Turborepo). Must pass before every commit.
- `pnpm format` / `pnpm format:check` — Prettier.
- `pnpm --filter @bizcost/domain test` — run one package's task.
