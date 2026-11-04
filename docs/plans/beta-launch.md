# Beta launch plan: BizCost online, closed, on the web

The plan behind docs/ROADMAP.md §Milestone 4 "Beta launch". Status: **PROPOSED** (2026-10-31). The owner decided its direction on 2026-10-31 (D-347, «1أ-2أ-3أ»): the web app goes online first as a closed beta for businesses he invites; the mobile app comes later; it runs after M4 Step 2 and before Step 3. It starts on the owner's «ابدأ» and his answers to the questions below.

## Goal

About 5–15 real businesses the owner invites (his own joinery among them) use BizCost on the internet, on a computer or a phone's browser, with their real data kept safe, and tell him what they think, while M4 goes on being built.

- **What they get:** everything released today: Smart Setup, the Costing Core (materials, products, recipes, purchases, expenses, running costs, product costs), Sales & Profit (sales, imports, orders, customers, payments, real profit, quotations and invoices). Nothing still `planned` (Stock, Usage & Waste) shows to them until its release (D-125).
- **What it is not:** the mobile app (still deferred, D-347), store builds, subscriptions or payments, open sign-up, a marketing site.

## What is already built for this (M1, deferred until now)

- Hosting design: Supabase in Mumbai (`ap-south-1`) and Vercel with functions in `bom1` (ARCHITECTURE.md §Environments & deployment).
- `db-migrate.yml`: migrations and Auth settings reach a hosted project only through it, staging first, production with the owner's approval (D-100, D-106).
- Runbooks: migrations, the `bizcost_api` password, key rotation, restore, a blocked `supabase.co` (ARCHITECTURE.md §Runbooks).
- Security: tenant isolation, permissions and hidden fields on the server, cross-tenant attack tests, CAPTCHA hooks (D-062), Sentry with cost values redacted.

## Steps

- [ ] **Step 1: Accounts, domain and DNS (the owner, with a checklist from Claude).** The domain (Q1); Supabase: production project on Pro (daily backups) next to the existing `bizcost-staging` (Q2); Vercel Pro; Resend with the domain verified (SPF, DKIM, DMARC; one subdomain for sign-in codes, one for notifications); Cloudflare Turnstile keys; GitHub Environments `staging` and `production` with their secrets; Sentry. Claude writes the exact list of names and where each goes; the owner types every secret himself (Claude never sees or handles one).
- [ ] **Step 2: Staging online.** `db-migrate.yml` dry run, then real, on staging; the `bizcost_api` password (runbook); Vercel preview environment; prove the pooler login (M1 Step 0c) and the function region; smoke test: health, sign-up and sign-in with an emailed code, Smart Setup, a purchase, a sale, real profit, an invoice PDF, a logo upload, an invitation email. Fix what only shows when hosted (time zones, cold starts, email delivery, file sizes). Demo businesses on staging for showing people (`demo:seed` against staging, if Q6 = A).
- [ ] **Step 3: Closed sign-up and feedback (small code changes).**
  - **Access** (Q3): sign-up only for the invited.
  - **Feedback** (Q4): a "Send feedback" button on every page.
  - **Legal pages:** Privacy policy and Terms of use in Arabic and English, linked from sign-up (accepted once) and the account menu. Claude drafts them in simple words from what the app really stores; a UAE lawyer reviews them before the first paid customer (not needed for a free beta, but recommended).
  - Each with its i18n, tests and a decision.
- [ ] **Step 4: Production online.** The same path as staging with the owner's approval; a restore tested once (runbook §Restore) before the first business signs up; Sentry alerts and an uptime check on `health`; the owner signs up first and sets up his joinery.
- [ ] **Step 5: Invite and listen.** The owner invites the first businesses; Claude reads the feedback with him each week and turns it into fixes or plan changes (each one he approves). The release routine (Q5) starts.

Estimate: about **1 week of calendar time**, most of it waiting on the owner's accounts and DNS (a domain's records can take hours to a day). Claude's part: about 2–3 working days.

## Monthly cost (approximate, before VAT)

| Item                              | Cost                                       |
| --------------------------------- | ------------------------------------------ |
| Domain (`.ae`)                    | about AED 125–145 a year                   |
| Supabase Pro (production)         | about $25 a month                          |
| Supabase staging                  | Free (it pauses when idle)                 |
| Vercel Pro                        | about $20 a month                          |
| Resend, Turnstile, Sentry, GitHub | Free tiers are enough for a beta           |
| **Total**                         | **about $45 a month (≈ AED 165) + domain** |

Later, not for the beta: PITR backups (about $100 a month) before the first paying customer; the Supabase custom domain `auth.<domain>` (a Pro add-on) before the first store build.

## How development goes on during the beta

- Every change reaches the businesses through staging first: migrations by `db-migrate.yml`, written so the running app keeps working (expand → contract; ARCHITECTURE.md §Runbooks), then the app.
- Modules still being built stay `planned` and hidden (D-125); M4's Release A shows Stock to them when it is ready.
- A bad release is fixed forward; their data is backed up daily.

## Definition of done

- [ ] The owner opens `https://app.<domain>` on a computer and a phone, signs up with a code from his email, and sets up his joinery through Smart Setup.
- [ ] Someone not invited cannot sign up; an invited business can, and invites its own team.
- [ ] "Send feedback" reaches the owner with the page it came from.
- [ ] Privacy policy and Terms are linked from sign-up, in both languages.
- [ ] A migration went local → staging → production through `db-migrate.yml`.
- [ ] A restore was tested; Sentry receives a test error; the uptime check alerts.
- [ ] Nothing `planned` is visible on production.

## Questions for the owner

| #   | Question                   | Options (recommended first)                                                                                                                                                                                              |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | The domain                 | **A)** `bizcost.ae` (looks free; about AED 125–129 the first year at a UAE-accredited registrar). **B)** `getbizcost.com` (about $10.5 a year at Cloudflare). `bizcost.com` is listed for sale, usually at a high price. |
| Q2  | Environments               | **A)** Two: staging (the existing Free project) and production (Pro), so a change is tried before the businesses get it. **B)** Production only (cheaper and quicker, but every change goes straight to them).           |
| Q3  | Who can sign up            | **A)** Only an email you add to the beta list (from a small page only you see, or by telling Claude). **B)** Anyone with an invitation code you give out. **C)** Anyone who finds the link.                              |
| Q4  | Feedback                   | **A)** A "Send feedback" button in the app: the message, the page it came from and an optional screenshot, saved and emailed to you. **B)** Only a WhatsApp or email link.                                               |
| Q5  | Releases to the businesses | **A)** Once a week, after a check on staging. **B)** As each step is done.                                                                                                                                               |
| Q6  | Your local data and demo   | **A)** Production starts clean (you set up your real joinery there); the demo businesses go on staging only, for showing people. **B)** Copy your local business to production.                                          |
