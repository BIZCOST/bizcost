# Milestone 3 plan: Sales & Profit

The full plan behind docs/ROADMAP.md §Milestone 3. Status: **APPROVED** on 2026-10-04 with every question answered as recommended (D-218). Built from the owner's spec, the codebase, UAE VAT and e-invoicing texts (MoF, FTA; checked 2026-10-04) and sales-capture research, by three independent plans, a judge and two critics. Once a step is built, ROADMAP.md holds its status and DECISIONS.md its decisions; this file is the plan, not the record.

## Milestone 3 = Phase 3 Sales & Profit

Goal: every business, whatever its type, records its sales the way it already sells. It then sees its **real profit** by product, order, day, week, month, channel and branch, and for the whole business.

- **Real profit** is sales before VAT, minus:
  - materials by recipe, at the average cost, frozen when the sale is finalized;
  - app and selling fees;
  - delivery the business paid;
  - the running-cost share (by price, D-202);
  - for a business without a team, the owner's time.
- **The first real profit comes early**, from the simplest entry: today's sales typed in, or one sale.
- **Release A, half-way through**, adds file import, orders with delivery and deposits, and what customers owe.
- **Release B, last**, adds quotations and UAE invoices on the same sales model. They are ready for e-invoicing through an accredited provider (D-005), which gets its own milestone.

Estimate: **~20–23 weeks solo**, on the same basis as M1 and M2 (each 9–11 weeks). M3 is about 2× M2. It adds:

- three document kinds and gapless numbering;
- an Arabic PDF engine;
- an importer;
- orders, payments and refunds;
- the profit views.

- **Per step, in weeks:** 1 (1.5), 2 (2.5), 3 (2.5), 4 (2.5), 5 (3), 6 (1), 7 (2), 8 (3), 9 (0.5), 10 (1.5).
- **Real pace so far:**
  - M1 ran 2026-09-24 → 09-27.
  - M2's build ran 2026-09-27 → 10-01: 5 working days for 9–11 estimated weeks.
  - With the owner's answer rounds (D-204, D-216), M2 took about 8 days.
- **At that pace,** M3 builds in roughly **10–12 working days**. With the owner's answers, his two reviews and one round of his follow-up requests, that is **about 3–4 weeks of calendar time**.
- **What can slow it:**
  - the 27 answers;
  - the PDF engine running on a server (tried in Step 1);
  - real export files (Step 4);
  - the two reviews.
- **The tax agent's look at the PDFs** is needed before the first real user, not for Release B on the local web.
- The e-invoicing connector is not in this estimate (Q24).

Status (2026-10-04): **APPROVED** (D-218: every question answered as recommended).

- **He approves the milestone once and answers Q1–Q27 below.**
  - "All as recommended" is enough.
  - Any answer can be changed until its deadline.
  - Nothing is built before that (CLAUDE.md).
- **Deadlines:** Step 1 needs Q1–Q8; every other question is due before a later step, given with it.
- **D-216 first.** M3 builds on D-216, the owner's answer «1أ» (a bill pays one running cost), built with its review fixes as D-216 and D-217 (on `main`, 312f9bc).
- The owner's approval and answers are D-218; M3's decisions follow from D-219.
- Web only: mobile and the hosted deploy stay DEFERRED by the owner.

Release rule:

- **Before their release step,** the M3 modules stay `planned`. Their screens run only in tests and on local development servers with the dev-only preview (`BIZCOST_PREVIEW_MODULES`, D-125). Their e2e specs run on `next dev` (D-127).
- **Release A (Step 6):** `sales`, `reports`, `customers`, `payments` and `orders`.
- **Release B (Step 9):** `quotations` and `invoices`. They keep the "soon" chip in Customize BizCost and in Smart Setup's review until then (D-003, D-075).
- **After each release,** every spec of the released modules runs on the production build (D-199).
- **Smart Setup already writes `business_modules` rows** for these modules, so each release shows them at once where setup turned them on:
  - Sales and Reports everywhere;
  - Customers and Payments where Orders, Quotations, Invoices or Projects are on (PRODUCT §6.6).
- **Each module gets its keys, template defaults and backfill migration** in the step that builds it (D-124).
- **Released businesses see no change before Release A** (D3). Each change below shows only while its module is served (`isModuleServed`, and the API's module gate):
  - the Dashboard's new cards and checklist steps;
  - Settings → Sales channels;
  - the "What does this expense pay?" choices for app fees and delivery;
  - a member's "Branches they work in";
  - Settings → Documents, the business address and trade licence fields.

  The one exception ships at once in Step 5, because it belongs to the released Purchases: "Money back from the supplier" (Q18). With no sales, Product costs' share stays `awaiting_sales`.

### First real profit, by business type

| Business (PRODUCT §6.11, §12)                             | How its sales come in during M3                                                                                       | First real profit (preview) | Released      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------- |
| Home baker, alone, not VAT-registered                     | Today's sales (Step 2), then Orders with delivery, deposits and refunds (Step 5)                                      | Step 3                      | Step 6        |
| Coffee shop: POS, VAT, 2 branches, Talabat                | Today's sales per branch (Step 2), then the POS file and the Talabat statement (Step 4)                               | Step 3                      | Step 6        |
| Restaurant: POS, VAT, service charge, tips, delivery apps | The POS file (service charge as sales, tips skipped) and app statements (Step 4)                                      | Step 3                      | Step 6        |
| 3D-printing maker                                         | Today's sales, marketplace files with a fee column (Step 4), Orders with deposits (Step 5)                            | Step 3                      | Step 6        |
| Online seller (Shopify or noon store, Orders off)         | A line file with fees (Step 4)                                                                                        | Step 3                      | Step 6        |
| Retail shop: POS, VAT                                     | Today's sales, then the POS item file matched by code (Step 4)                                                        | Step 3                      | Step 6        |
| Freelance designer, services, not VAT-registered          | One sale per job with "they'll pay later" (Steps 2, 5), then quotes and plain invoices from those sales (Steps 7–8)   | Step 3                      | Steps 6 and 9 |
| Fit-out or events company: VAT, team                      | One sale per stage (Step 2); job materials through Q13; then quotes with revisions and stage tax invoices (Steps 7–8) | Step 3                      | Steps 6 and 9 |
| Solo project business, Materials off                      | One sale per job (Step 2): profit is sales − running costs − her time                                                 | Step 3                      | Step 6        |
| Garage, VAT                                               | One sale with parts bought ready to sell plus typed labour (Steps 2, 7), then tax invoices (Step 8)                   | Step 3                      | Steps 6 and 9 |
| Small factory, VAT, 2 sites                               | Orders on credit with the customer's LPO (Step 5), then tax invoices per site and monthly statements (Step 8)         | Step 3                      | Steps 6 and 9 |
| Carpentry workshop, VAT                                   | Orders from deposit to delivery (Step 5), then quotes (Step 7), deposit and final tax invoices (Step 8)               | Step 3                      | Steps 6 and 9 |

### Risks retired, in order

| Risk                                                                                                      | Retired in                                        | Proof                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| VAT maths that e-invoicing refuses; Round the total with mixed rates; IBR-147-AE line nets                | Step 1 (pure code)                                | Goldens and properties against PINT-AE S-08, S-09 and IBR-147-AE                        |
| An Arabic PDF engine that renders correctly and safely on a server                                        | Step 1 bake-off; used from Step 7; Step 10 review | Measured comparison in a D-entry; text-layer goldens; no network or script in rendering |
| A sale's cost while purchases, reversals and fills post at the same moment                                | Step 2                                            | `sales.concurrency.api.test.ts`: no deadlock, no missed fill (first purchase included)  |
| A hidden cost found by a failing post (D-209)                                                             | Step 2                                            | Adversary case: huge quantity at price 0 never fails differently                        |
| The running-cost share switched on (shares add up to the month's costs; the D-203 residue; a first month) | Steps 1 and 3                                     | Property tests; redaction oracle                                                        |
| Real profit computed on read, under the 15 s statement timeout                                            | Step 3                                            | Budget: a year of a two-branch café in under 1 s                                        |
| Messy files at scale (encodings, Arabic headers, re-imports)                                              | Step 4                                            | Fixture corpus; dedupe suites; time budget                                              |
| Gapless numbering under concurrency and replays                                                           | Step 5 (order numbers), then Step 8 (invoices)    | Parallel-issue and replay suites; pgTAP                                                 |
| VAT charged twice after a deposit; sales or amounts owed counted twice                                    | Steps 5 and 8                                     | Properties: deposit VAT + final VAT = VAT on the work; one owed figure per obligation   |
| The e-invoicing seam                                                                                      | Steps 1 and 8                                     | The domain's PINT-AE checks; the readiness test                                         |

- [x] **Step 1: Domain groundwork for sales documents and real profit** (DONE 2026-10-04; decisions Q3–Q8; D-219–D-223 for the domain engines with the fixes of their review, D-224 for the PDF engine; 514 tests in the package, 79 new; status in ROADMAP.md). Pure TypeScript in `@bizcost/domain`, decimal.js only, as in M2 Step 1 (D-107–D-110). It stores no data and releases nothing.
  - **Sales document maths** (`documents/sale.ts`, `computeSale`): one engine for a sale, an order, a quotation, an invoice and a credit note.
    - **Prices:**
      - Prices are before VAT, or include VAT when the product says so (D-121).
      - `beforeVat` moves out of `computePurchase` into a shared helper. Purchase results stay byte-identical, and their tests guard that.
    - **Discounts:** a line discount is a % or an amount, before VAT. An optional document discount is split by line net with `splitByWeights` (D-114 rule 4).
    - **Charges:** delivery charged to the customer is a `delivery` line, standard-rated for a VAT-registered business. Other charges are `charge` lines.
    - **VAT categories:**
      - Each line copies its VAT category and rate from the product (`saleVatRate`).
      - Zero-rated and exempt are both 0%, but they stay apart (different labels on a tax invoice).
      - **For a business not registered for VAT, no line carries a VAT category or rate, whatever the product says** (D-121, D-206). The document records the VAT registration it was made under, which is frozen at posting.
    - **VAT is worked out once per VAT rate**, on that rate's taxable total, rounded half away from zero (Q4).
      - It is then split back over the lines by largest remainder, so the printed line VAT adds up to the total.
      - With VAT-inclusive prices, each rate's inclusive total stays exact: VAT = gross × 5 ÷ 105, rounded once.
    - **IBR-147-AE:** line net = quantity × net price. Where a line's net ÷ quantity is not exact, its price is expressed per the line's quantity (IBT-149) when it is mapped for e-invoicing. A property proves that every line maps.
    - Refunds and credits are negative quantities.
    - Purchases keep D-107's per-line rounding, since they are the supplier's documents.
  - **Round the total** (`solveRoundAmount`, rebuilt; D-107 removed it):
    - the user types the total wanted, with VAT;
    - the adjustment is made before VAT and split over the VAT rates by their net;
    - a fils the rates cannot reach goes to a "Rounding difference" of at most 0.02. That cap is BizCost's own; PINT-AE only has the field (ibt-114);
    - no line goes negative.
  - **Cost of what was sold** (`costing/sale-cost.ts`, `saleLineCost`):
    - One unit sold uses the recipe's `base_qty ÷ yield_qty` (D-178), or the item's own material when it was bought ready to sell (D-117).
    - Each material is costed at the D-115 average **as of the sale's day**: purchases in the 90 days ending that day, else the last purchase. It uses the purchases posted when the sale is finalized.
    - A material with no price yet gives "no price yet" (null, never 0; D-186), filled once later (Q5).
    - **The owner's time** is minutes × hourly rate × quantity, only without a team (D-119). When no hourly rate is set yet, it is null and is filled once when the rate is set.
    - All of it is shaped as the snapshot that posting stores.
  - **Real profit** (`costing/real-profit.ts`), per line and summed:
    - **The formula:** sales before VAT − materials − channel fees − delivery cost − running-cost share − the owner's time (Q7). Each part has a state, and nothing missing is ever 0.
    - **The share is worked out at the price actually sold:** line net × the month's costs ÷ the month's item sales before VAT.
      - It is one exact division, rounded once to 12 decimals (`costShare`, D-202).
      - Only item lines carry a share. Delivery charged meets its own cost: delivery margin = charged − actual cost.
      - Months whose item sales are 0 or less carry no share (D-202).
    - **The rate's basis (Q6):**
      - `month`: a finished month uses its own costs ÷ its own sales.
      - `last_month`: the running month uses the last full month's rate.
      - `so_far`: a first month, explained below.
      - `none` and `applied` replace `awaiting_sales` once sales exist.
    - **Costs so far** (`monthCostsSoFar`, built on `costPool` and `daysRunIn`): running costs count for the days they ran up to today, and the month's bills and expenses are spread evenly over its days and counted up to today. It has two uses:
      - **The business-level profit of the running month** subtracts these costs, not a whole month's.
      - **A first month** (the month of the first finalized sale) counts its costs from the day of that sale. Its rate is those costs ÷ its sales so far, shown only once 7 days have passed since that sale (before that, "before running costs"). It uses the same costs from its first sale once it ends.
    - **The business's real profit** subtracts the month's costs: whole in a finished month, so far in the running one. The views by product, channel and branch carry shares. A line "Running costs not carried by this month's sales" holds the difference: zero in a finished month (within 12-decimal rounding), and non-zero in a first month or the running one.
    - **Channel fees (Q8):** a channel's fees for a period ÷ its item sales in that period × the line's net.
      - Fees come from posted statements covering the day. Without one, they come from expenses marked as that channel's fees for the month. Without either, the channel's commission % applies.
      - A statement whose period spans two months is split between them by days (one division).
  - **PDF engine bake-off** (1–2 days, in the scratchpad; no dependency joins any package before Step 7).
    - Candidates:
      - headless Chromium printing our own HTML page (`playwright-core` + `@sparticuz/chromium`);
      - Typst compiled to WebAssembly;
      - `@react-pdf/renderer` as the baseline.
    - Criteria:
      - **Arabic text:** shaping and joining, and bidi with Latin TRNs, LPOs and numbers in LTR isolates, read back in logical order from the PDF's text layer (pdfjs);
      - **Fonts:** IBM Plex Sans and IBM Plex Sans Arabic embedded (OFL);
      - **Pages:** A4 page breaks, with the table header repeated over 200 lines;
      - **Speed:** a 2-page invoice in under 1 s warm and 3 s cold;
      - **Size:** the API function's bundle size and cold start. They are estimated while hosting is deferred and re-checked at the first hosted deploy. If the engine needs its own route, that is a D-entry and an ARCHITECTURE change ("the only API entry");
      - **Security:** user text escaped, JavaScript off, no network or file access while rendering;
      - deterministic output for golden tests;
      - no paid service.
    - The result is recorded as a D-entry ("PDF engine with correct Arabic", ROADMAP §Open), with the runner-up as the fallback. Recorded as D-224: Typst compiled to WebAssembly, in a worker that is replaced; headless Chromium is the fallback.
  - **Tests.** The owner's examples as golden tests:
    - 7 lines of AED 10.10 at 5%: VAT 3.54 (four lines of 0.51 and three of 0.50), not 3.57;
    - "Round the total" 1,120.00 → 1,100.00, and mixed rates 2,600.00 → 2,500.00 (definition of done);
    - an unreachable 1,000.12 gives 1,000.11 + a rounding difference of 0.01;
    - the Spanish Latte's materials: 3.002034632035 a cup;
    - the café's September: 20,000 ÷ 80,000 = 25%, so an AED 18.00 latte carries 4.50, and Talabat's 1,800 ÷ 10,000 = 18% adds 3.24;
    - 20,000 ÷ 30,000: the shares add up within the 12-decimal tolerance, and the business total subtracts exactly 20,000;
    - a first month's 6,000 × 15 ÷ 30 = 3,000 ÷ 12,000 = 25%;
    - the home baker's order #1001 earns 35.10.

    Fast-check properties:
    - VAT per rate = taxable × rate (S-09), and the printed line VAT adds up to it;
    - a typed total is reached within the rounding difference;
    - a finished month's shares add up to its costs, and a channel's fees add up to its statements;
    - a refund mirrors its sale;
    - a cost, once set, never changes;
    - a business not registered for VAT never gets a VAT amount.

  - Depends on: M2; D-216's domain change merged.

- [x] **Step 2: Today's sales and One sale, finalized with their cost** (DONE 2026-10-05; decisions Q9–Q12; built as D-225–D-235, review fixes D-236. Checks at the end: `pnpm check` 31/31 tasks with 1,620 unit tests, `pnpm db:test` 1,288 pgTAP + 59 database tests, `pnpm api:test` 2,117 tests in 73 files, `pnpm e2e` 136 passed; ROADMAP.md holds the status).
  - **Data** (migrations `sales_tables`, `sales_security`):
    - `sales_channels`: one table for every way a business sells.
      - `name`, one per business by `app.name_key`.
      - `kind`: shop | messages | website | delivery_app | marketplace | other.
      - `fee_percent numeric(9,6) NULL`: what the app keeps of each sale before VAT, tagged `cost`.
      - `archived_at`.
      - **Seeding:** each business gets the channels its Smart Setup answers name ("Shop", "WhatsApp & phone", "Online"), or one "Direct" channel when none fits. Existing and demo businesses get theirs by migration. Talabat, Deliveroo, Careem, noon Food, Keeta, noon and Amazon are presets in "Add a channel".
    - `sales`, the header:
      - `business_date`, and `period_from NULL` for a sheet covering several days (Q9);
      - `location_id`, `channel_id`;
      - `source`: day_sheet | single. Later steps add import, order, invoice and credit_note;
      - `status`: draft | posted | reversed;
      - `vat_registered`, frozen at posting;
      - `currency`, and the document totals: subtotal, discount, net, VAT, total;
      - delivery: `delivery_needed`, `delivery_area`, and `delivery_cost numeric(20,4) NULL` (tagged `cost`);
      - `posted_at`, `posted_by`, the reversal columns (with `reversal_business_date`), `copied_from_id` and `notes`.
      - **No cost total on the header:** cost totals are worked out on read from the lines (H4).
    - `sale_lines`:
      - `kind`: item | delivery | charge;
      - `product_id`, and `description`, copied from the product and editable (D-002);
      - `qty numeric(24,6)` ≠ 0, capped in the DTO; `unit`, `unit_price`, `price_includes_vat`, the discount;
      - `vat_category`, `vat_rate` and the amounts;
      - set at posting: `cost numeric NULL`, `cost_basis` (recipe | resale | none) and `time_cost numeric NULL`.
    - `sale_line_materials`: for each material, `base_qty`, `unit_cost numeric NULL`, `cost numeric NULL` and `basis`.
      - The cost columns are unbounded `numeric` with a 12-decimal scale check, so no hidden cost can make a post fail (H3, D-209).
      - These rows are the snapshot. They give each line's breakdown now, and **they are the expected usage that Phase 4 reads, with no migration**.
    - **Unique keys apply to live rows only** (partial indexes, H7). One open sheet per member × day × channel × branch (Q10). A reversed sale frees its key.
    - **Guards and checks:**
      - `app.guard_books_closed` and its INSERT triggers cover `sales`, also for rows written already posted (D-205, D-211);
      - `guard_posted_document` / `guard_posted_lines` are attached. On a posted sale, they allow only each fill-once below, and only while its column is still null:
        - a material's cost, and the line cost that follows from it;
        - the owner's time;
        - the delivery cost;
      - audit and touch triggers, composite FKs, RLS;
      - pgTAP `24_sales`.
  - **Posting:**
    - **Lock order** (extends D-110): the sale FOR UPDATE → the business FOR SHARE → any missing cost rows inserted with `on conflict do nothing` (as `lockCostRows` does) → its materials' cost rows FOR SHARE, in ascending id. One set-based statement then freezes every line's materials. So a purchase posting at the same moment is either inside the sale's cost or fills it afterwards, never missed. That holds even for the first purchase of a material (H4).
    - **Nothing leaves stock (Q5):** no movement and no change to any cost row's values. A sale is never refused for stock. A test asserts that the stock ledger, the `material_costs` values and `ledgerDrift` are unchanged by sales.
    - **Reversal:**
      - In an open period, a reversal is as if the sale was never posted.
      - When the sale's day is closed, the reversal is dated the first open day, and its negative counts in that day's month, in sales and in the share's denominator. This mirrors D-200 and D-203, and D-114 rule 3.
      - Correct = reverse + a draft copy (D-036).
    - **Fills, once:**
      - Posting a purchase fills the missing material costs of earlier finalized sales of its materials. It runs after the purchase's own locks, and it updates only `sale_line_materials` rows and line costs that are still null, never the sale header. This is a new lock edge (cost rows → sale lines), recorded in a D-entry and in the lock-order comment of `stock.ts`. A sale's reversal touches only the header, so the two never wait on each other.
      - Setting the owner's hourly rate fills the missing time costs.
      - A member with the costs switch may fill a missing delivery cost once.
      - A fill into a closed month is allowed, because it only completes a cost shown as "no price yet" (Q5).
  - **API:**
    - **Channels:** `channel.list/create/update/archive/unarchive`. The fee % is set and seen only with the costs switch (D-187).
    - **Lists:** `sale.list` filters by day, channel, branch, source and status, with a search in product names, never in an amount (D-209).
      - A member without `sales.documents.view` sees only the sales they entered, as D-181 and D-214.
      - A member limited to branches sees only those branches (Q12, `member_locations`, D-054).
    - **One sale:** `sale.get`, and `sale.create/update/discard`, idempotent and versioned.
    - **Posting:** `sale.post`, `sale.reverse` and `sale.correct`. A repeated post or reverse returns the recorded result.
    - **The day sheet:** `sale.daySheet` lists the branch's products (`product_locations`), ordered by what the member sold in the last 30 days, then by name, never by the business's totals. It fills in the last price.
      - Each member has their own sheet per day × channel × branch; asking again opens it.
      - With two sheets for the same day and channel, members who see all sales get a note: "2 sheets for Shop on 8 Oct (Ali, Sara)".
    - **Keys:** `sales.documents.view` (every sale, and so the sales totals, H1), `.manage`, `.post`, `.reverse`, and `sales.channels.manage`. They come with template defaults (Q10) and a backfill migration (D-124). Preview: `BIZCOST_PREVIEW_MODULES=…,sales`.
    - **Delivery cost:** the member who enters a sale may type the delivery cost they paid and sees it on their own records (D-181). The amount is otherwise tagged `cost`.
    - **Capability gates (D-192):** VAT fields only when VAT-registered; branch only with `multi_location`; "entered by" only with a team.
  - **Screens** (`features/sales`, namespace `sales`):
    - **Shared parts:** the purchase editor's shared parts move to `features/documents`: totals, amounts with locks, the confirmation dialog, panel, status badge, line editor. This touches released screens, so Step 2 runs every M2 e2e spec on the production build.
    - **Sales** page: days, newest first, with each day's total before VAT, its channel and its status. Filters live in the address.
    - **Today's sales** («مبيعات اليوم»), phone first:
      - your products with − / + steppers, the price filled in (editable for the day) and a running total;
      - "These sales are for: today / another day / several days (within one month)". It is never after today and shows the books-closed note;
      - the channel only with 2 or more channels; the branch only with branches;
      - Save and «اعتمد نهائيًا». Leaving with changes asks first (D-161).
    - **One sale** («عملية بيع»), for a job or a single customer:
      - lines with a product or service type-ahead and "Add a new one" (quick create, as `material.quickCreate`), quantity, price and discount;
      - delivery: yes or no. Yes asks for the area, the amount charged and what it actually cost.
    - **The sale as recorded:** each line's cost and profit with the costs switch, locks without it. Reverse and Correct are confirmed by a dialog that says what changes.
    - **Settings → Sales channels:** the list, add (with the presets), archive, and "What does the app keep from each sale?" with the costs switch.
    - **A member's page:** "Branches they work in" (all by default), only with branches and a team (Q12).
  - **Tooling:** `pnpm dev:clean-test-data` and `demo:reset` learn the M3 tables, with their local-only bypass of the posted-row guards, and are tested (D-182, D-185).
  - **Tests:**
    - `sales.api.test.ts`:
      - the Spanish Latte sold on 3 Oct keeps 3.002034632035 after a milk purchase on 5 Oct;
      - a purchase dated 1 Oct but posted after the sale is not in it;
      - a sale before any purchase shows "no price yet", and the first purchase fills it once;
      - reverse and correct; closed books (API and pgTAP); a reversal of a closed day counted in the open month;
      - VAT per rate; a business not registered for VAT; a sheet for several days; idempotency;
      - `ledgerDrift` unchanged.
    - `sales.concurrency.api.test.ts`: 50 sales and 20 purchases, with reversals, on shared materials, in opposite orders. It includes:
      - a material's first purchase racing a sale of it;
      - a sale's reversal racing a purchase that fills it.

      There must be no deadlock, and no sale left without the cost a concurrent purchase should have filled.

    - D-209 adversary: a price of 0 and a huge quantity never fail differently from a small one.
    - Every hardening suite gets the new procedures: cross-tenant, audit coverage, gates, Arabic-Indic digits, the redaction oracle × 7 templates, `no-stock`, the contract test.
    - `sales-visibility.api.test.ts`: own-only lists, branch-limited lists, and no total for a member who sees only their own.
    - `sales.spec.ts` on the preview:
      - a café's Today's sales in Arabic on a phone, typed in Arabic-Indic digits;
      - the designer's One sale in English on a desktop;
      - an employee who sees only their own sheet.
  - Depends on: Step 1.

- [ ] **Step 3: Real profit: running costs switch on, the Dashboard's cards and Reports** (APPROVED; decisions Q13, Q14). Real profit is worked out on read, and no profit is stored (as D-186). It is read from:
  - the posted sales and their snapshots;
  - the month's costs (`costPool`, D-202, D-203, D-216);
  - the channel fees;
  - the owner's time.
  - **Domain:**
    - **Materials no product uses (Q13 A):** `costPool` gains the goods cost of purchases of materials that no product or service uses, by their purchase month. Their reversals are counted like expenses.
    - **Fees and delivery on expenses:** an expense can say it pays "App fees of [channel]" or "Delivery already on my sales and orders" (Q8). This extends D-216's "What does this expense pay?". Such an expense never counts in the month's costs. A fees expense is the channel's fees for its month when no statement covers it.
    - **A property test:** one statement and one expense for the same fees count once.
  - **API:**
    - **Product costs:** `productCost.list/get` switch the share on.
      - The states become `none` / `applied`, with the basis `month` / `last_month` / `so_far`.
      - The DTO enums in `contracts/src/dto/product-costs.ts` widen; `shownRateState` / `shownShareState` stop throwing; `monthCostsOf` passes the month's item sales in place of `sales: null`.
      - **A product without a list price** stays `no_price` on Product costs, while in real profit it carries its share at the price it was sold for (D-202 Open).
    - **`profit.summary`:**
      - a month, or from–to within 12 months;
      - grouped by month | week (Monday to Sunday) | day | product | channel | branch (with branches); "order" comes in Step 5;
      - each group gives sales, materials, fees, delivery (charged, cost, margin), running costs, the owner's time, real profit and margin %;
      - the business level adds "Running costs not carried by this month's sales".
      - **Completeness:** each answer says how complete it is ("96% of sales have complete costs", and what is missing). That note is withheld like profit (H2).
    - **`dashboard.cards`** returns only the cards the business has data for and the member may see:
      - real profit this month against last month;
      - sales this month against last month;
      - where the money went (materials, fees, delivery, running costs, your time);
      - sales and profit by day;
      - top products, by quantity and margin %;
      - sold at a loss or a low margin (Q14);
      - cost increases (Q14);
      - sales by channel (with 2 or more channels);
      - needs a look: unpriced materials behind sales, a channel with sales but no commission %, statement or fees expense, products that sell without a recipe, materials bought but in no recipe.
    - **Hidden values:**
      - Profit is `profit_margin`, and costs are `cost`. **Aggregates are withheld in the services**, not just redacted (ARCHITECTURE §Redaction).
      - Grouping, sorting or filtering by a hidden value is FORBIDDEN (`assertQueryable`).
      - Sales totals: whoever holds `sales.documents.view` (H1).
      - **`reports.profit.view` (Q11)** needs the costs switch and `cost_engine.product_costs.view`. A key missing what it needs grants nothing (D-190).
      - Profit reports show the month's running-cost total, but never its categories, which stay with `running_costs.items.view` and `expenses.documents.view` (D-202). The residue is accepted in Q11.
      - "Sold at a loss", completeness notes and "sells without a recipe" are cost facts, withheld from members who see only sales.
      - A member limited to branches sees only their branches, without the business-level line.
    - **Refresh (D-212):** `sale.post` / `.reverse`, fills, statements, marked expenses and hourly-rate changes make stale Product costs, the Dashboard cards and `profit.summary`. Tests cover each.
    - **Sales switched off in Customize (M9):** the Sales page and its entry screens go. Sales already posted still count, because they are what was sold, and Orders and Invoices keep posting sales. With no sale at all, the cards stay hidden.
    - The Reports manifest stays planned and is previewed.
  - **Screens:**
    - **Dashboard decision cards** (PRODUCT §9): stacked on a phone, a grid on a desktop. There is no card for data the business doesn't have, and none at all while Sales is not served. The checklists stay.
    - **"Sales and profit by day":** one accessible SVG chart drawn in-house with the `chart-1..6` tokens, mirrored in RTL, with a table for screen readers. **No chart library** (Q14).
    - **Reports → Real profit** («الربح الحقيقي»):
      - a period picker; By month / week / product / channel / branch / day;
      - "Show" and "Sort by" only on what the member sees;
      - every figure says how it was worked out ("Running costs: September's AED 20,000 ÷ AED 80,000 of sales = 25% of each sale's price");
      - By branch says "Each branch carries the business's rate" (B18).
    - **Product costs:**
      - the share line is live: "AED 4.50 · 25% of its price (September 2026)";
      - margins are after running costs;
      - D-203's "before running costs" words stay only while a share awaits sales.
    - **The cost checklist** becomes "Let's calculate your first real profit" («لنحسب ربحك الحقيقي الأول», PRODUCT §10):
      - it adds "Add or import your sales" (done with one finalized sale) and "See your real profit" (done once a finalized sale has a complete cost);
      - `COST_STEP_RULES` change;
      - "Your real profit is ready" replaces "Your product costs are ready".
    - **Expenses:** the "What does this expense pay?" choice gains "App fees of [channel]" and "Delivery already on my sales and orders" while Sales is served.
    - **Honest words** (D-203):
      - "Materials (by your recipes, at your average cost)";
      - with `keeps_stock`: "Waste and stock differences come with stock counts";
      - for the running month: "At September's rate until October ends";
      - a channel without fees yet: "before app fees";
      - for a first month: "So far this month, from your first sale on 1 Nov".
  - **By business type:**
    - café: ingredients and running costs as a % of sales, top products, by branch;
    - home baker: materials, her time, delivery;
    - designer: each service after running costs and her time;
    - fit-out: job materials inside running costs (Q13), with the words saying so.
    - No Labour, Waste, Stock, Usage or Packaging cards: Phases 4–5. Packaging needs a kind of material that doesn't exist; it is in recipes today.
  - **Tests:**
    - the café's September, the baker's order and a first month (definition-of-done numbers);
    - the running month at the last full month's rate; Running Costs and Expenses off (`off`); refunds;
    - fees counted once (statement vs marked expense vs %); materials in no recipe;
    - the redaction oracle:
      - profit and costs withheld for Sales, Supervisor and Employee, and seen by Accountant;
      - a custom role with profit reports but no running costs sees the month's total and never its categories;
    - budget: a year of a two-branch café's daily sales, `profit.summary` under 1 s locally;
    - `profit.spec.ts` on the preview: owner and employee, AR/EN, phone and desktop.
  - Depends on: Step 2; D-216's screen round merged (`month-costs.tsx`).

- [ ] **Step 4: Import sales from a file, and app fees by channel** (APPROVED; decision Q15). Files are read in the browser and never uploaded:
  - the `business-files` bucket keeps its four file types (DATA_MODEL §1.8);
  - no background job is needed: rows reach the API in chunks of up to 1,000 (within the batch limit), and only day totals are posted.
  - **Domain** (pure, `sales/import/`; it runs in the browser):
    - **Headers:**
      - find the header row, skipping title lines and "Total" / «المجموع» rows;
      - map headers automatically from English and Arabic names (Qty / الكمية, Net sales / صافي المبيعات, SKU, Branch, Commission…);
      - make a header fingerprint for saved mappings.
    - **Amounts** go through `parseNumber`. It also reads "AED" / «د.إ» prefixes, and "(12.00)" as a negative.
    - **Dates** are dd/mm/yyyy by default. Excel serial dates are read, and an ambiguous date is reported.
    - **`aggregateDaily`:** line files are summed into day × product totals, with order-level fields copied down to their lines. An optional fee column is summed by day into the channel's statement for the file's period (B9).
    - **`matchName`**, in order:
      1. the saved alias for the source;
      2. the exact code;
      3. `nameKey` (D-158);
      4. the 3 closest folded names (diacritics, ة/ه, أ/إ/آ→ا; Item + Variant as "Latte · Large").

      Product lists are small enough, so there is no `pg_trgm`.
  - **Web reading:** .xlsx, .xls and .csv; UTF-8 with or without BOM, UTF-16, Windows-1256; delimiter detection. The spreadsheet library is chosen and pinned in the step and recorded as a D-entry: SheetJS Community Edition from its official tarball, or exceljs + papaparse.
  - **Privacy:** customer names and phones in POS exports are never sent or stored.
  - **Data:**
    - `sale_imports`:
      - `channel_id`, `location_id`, `file_name`, `file_hash` (sha-256), `fingerprint`;
      - `shape`: lines | summary;
      - the period, kept within one month because the D-202 rate is monthly. **A summary over several days posts one sale on its last day**, marked "covers 1–30 Sep", like a sheet for several days (Q9);
      - `mapping` (JSON), `amounts_include_vat`, the counts;
      - `status`: draft | posted | reversed;
      - the days it replaced.
      - `file_hash` is unique only among imports that are not reversed (H7).
    - `sale_import_rows`: staged rows holding only the mapped columns, cleared at posting.
    - `import_profiles`: saved mappings, by source and fingerprint.
    - `product_aliases`: a source and a raw name key or code lead to a product, or to "not something I sell" with its treatment. Retail item codes live here. **There is no SKU field on products.**
    - `channel_statements`:
      - from, to, channel;
      - sales on the statement, commission, payment fees, other fees, ads, refunds charged, and the payout (for information only);
      - draft | posted | reversed;
      - tagged `cost`.
      - **Covered by the books-closed guard from this step** (S5).
    - `sales.source` gains `import`.
  - **API:**
    - **Creating:** `saleImport.create` refuses the same file twice ("Already imported on 8 Oct"). `saleImport.addRows` adds rows.
    - **The preview** (`saleImport.get`) shows:
      - rows read, days, sales before VAT, refunds and % matched;
      - days already imported;
      - errors with their row and column;
      - "Costs use the purchases entered so far", with the materials that have no price.
    - **Matching** (`saleImport.match`): match, match in bulk, add as new, or "not something I sell". Each answer is saved as an alias.
    - **Overlaps:** `saleImport.setOverlap` sets skip (the default) or replace.
    - `saleImport.discard`.
    - **`saleImport.post`:**
      - one sale per day × branch × channel, so a day can be replaced on its own;
      - "replace" reverses the earlier import's days;
      - one transaction, idempotent, with costs frozen and locked as in Step 2;
      - refused while a row is unmatched, or while a day is in closed books.
    - **Reversing and lists:** `saleImport.reverse` (the whole batch, or one day), `saleImport.list`, and `importProfile.list/remove`.
    - **Statements:** `channelStatement.list/get/create/update/discard/post/reverse`, and the statement template's import.
    - **Warning:** Today's sales and an import that cover the same channel and day get a warning.
    - **Keys:**
      - `sales.imports.manage`, which needs `sales.documents.manage` and `.post`;
      - statements need `sales.channels.manage` and the costs switch.
  - **Screens:**
    - **The Import wizard:**
      1. pick a file, the channel and the branch;
      2. the columns: mapped automatically, then confirmed; one click for a saved mapping;
      3. "These sales are for: a day / from–to", for summary files;
      4. "Do these amounts include VAT?", only for a VAT-registered business with no tax column;
      5. the names: "Did you mean…", "Add all as new", "Not something I sell":
         - tips are skipped;
         - a service charge counts as sales with no cost;
         - delivery charged counts in the delivery margin;
      6. the preview, then «اعتمد نهائيًا».

      Leaving with changes asks first.

    - **The Imports list** on the Sales page.
    - **Downloadable templates** (CSV with BOM; headers in English and Arabic, either accepted): daily sales by product; sales lines; channel statement.
    - **Statements:** Settings → Sales channels → a channel → its statements, typed in a form or imported.
    - **POS presets:** ready-made presets for a named POS ship only once tested on a real sample file (owner action).
  - **By business type:**
    - café and restaurant: the POS daily item file per branch, plus the Talabat statement;
    - retail: the item-wise file matched by code;
    - maker and online seller: marketplace and store line files with their fees.
  - **Tests:**
    - **The readers,** over a corpus of real-looking, anonymized files:
      - a Loyverse-like summary with no date column;
      - a Foodics/Square-like line file with refunds;
      - a Shopify-like file with order fields only on the first row;
      - a noon-like file with a fee column;
      - Arabic headers, Windows-1256, Arabic-Indic digits, Excel serial dates, "Total" rows, and modifiers kept as text.
    - **Duplicates and overlaps:**
      - the same file twice, and again after its import is reversed;
      - overlapping days skipped or replaced;
      - Finalize refused while a row is unmatched.
    - **Fees:** Talabat's 18%, a statement over two months (definition of done).
    - **Privacy and access:** no new Storage object; the oracle.
    - **Budgets:** 2 branches × 31 days × 120 products post in under 5 s, and a 50,000-row line file finalizes in under 10 s locally.
    - `import.spec.ts` (AR/EN).
  - Depends on: Step 3.

- [ ] **Step 5: Customers, Orders with delivery, customer payments, refunds and what customers owe** (APPROVED; decisions Q2, Q16–Q20).
  - **Domain** (moved here from Step 1, S1):
    - `orderTransition` / `orderActions`: Pending → Delivered or Cancelled, and Undo delivery (Q16);
    - `paymentState`: paid, deposit, unpaid or overpaid, built from `outstandingOf` / `overpaidOf` (D-160);
    - **Credit maths** (`documents/credit.ts`): what is left to refund or credit on each line, by quantity or by amount, never more. Each later credit starts from the adjusted value (VAT ER Art. 60).
  - **Data:**
    - `customers`, shaped like `suppliers` (D-112, D-123, D-133):
      - `name`, not unique (Q2), indexed by `app.name_key` for "Did you mean";
      - `kind`: individual | business | government;
      - `phone`, `email`, `trn` (15 digits, `parseTrn`);
      - for business and government customers only, `trade_licence_no`, for e-invoicing later (B15). Never an Emirates ID or a passport number;
      - `address_line`, `city`, `emirate` (the seven, only when the country is AE) and `country` (default AE), shown only with Invoices on;
      - `notes`, `archived_at`. Never deleted.
      - Personal data (M3):
        - pickers give a member without `customers.items.view` the name and the phone's last 4 digits only;
        - Sentry scrubs customer fields.
    - `document_counters`: `series`, `next_no`, `prefix`, `padding`.
      - The counter row is locked FOR UPDATE **last** in the creating or issuing transaction, after any cost rows (H9). Nothing else locks it, so it cannot deadlock, and it never waits behind a ledger replay.
      - A rollback gives the number back.
      - A replayed create is answered from the existing row **before** a number is taken.
      - Each document stores its number text and its integer, with UNIQUE (business_id, series, seq), so editing a prefix never renumbers anything.
      - First used here for order numbers (#1001…), which may skip when a create fails after validation. Invoices use the same design gaplessly in Step 8.
    - `orders` and `order_lines`:
      - `order_no`, `customer_id NULL`, `customer_ref` (the customer's LPO), `business_date`, `due_date NULL`, `location_id`, `channel_id`;
      - `status`: pending | delivered | cancelled;
      - the lines as `sale_lines`, and the document discount;
      - delivery: needed, area, charged as a line, actual cost (tagged `cost`; typed by the member who enters it, as in Step 2);
      - `notes`, `delivered_on`, `sale_id`, the cancel columns.
      - Attachment entity `order` (the factory's LPO copy).
    - `sales` gains `customer_id` and `order_id`, unique among live rows (H7), so a delivery can be undone and done again. `source` gains `order`.
    - **Refunds:** `sales.refund_of_id`. A refund is a negative sale linked to the sale it refunds, by quantity or by amount.
    - `customer_payments`:
      - `customer_id`, and exactly one of `order_id` / `sale_id` (`invoice_id` comes in Step 8);
      - `kind`: payment | refund;
      - `business_date`; `method`, required and never preselected (D-159);
      - `amount`, `currency`, `note`, `request_hash`, the reversal columns.
      - Append-only except their reversal, with closed books applied (D-160, D-205).
    - `purchase_payments.kind` gains `refund`, "Money back from the supplier", with who received it: the business, or a member (Q18).
  - **API:**
    - **Customers:** `customer.list/get/create/update/archive/unarchive/similar`.
    - **Orders:** `order.list/get/create/update/cancel`.
      - `order.deliver` posts the order's sale on the delivery day, with its lines and frozen costs.
      - `order.undoDelivery` reverses that sale and reopens the order. It is refused once the order has an issued invoice (Step 8) or its day is closed.
      - A delivered order is never edited. Cancelling a pending order changes nothing in the books.
      - Only a member who may see an order's payments can edit an order that has payments, and an edit below what was paid is refused (M2).
      - A repeated deliver returns the recorded result.
    - **Refunds:** `sale.refund` works on a finalized sale or a delivered order.
      - By quantity (goods returned), it takes off the original line's frozen unit cost.
      - By amount (a price cut), it takes off no cost.
      - It is never more than what is left, and can be recorded with a refund payment.
    - **Payments:** `customerPayment.list/record/reverse`. `services/payments.ts` gains orders and sales in its `DOCS` map, with `EXCEEDS_OUTSTANDING`, idempotency and the same locks.
      - **"Pay several at once"** applies one amount to a customer's open documents, oldest first or as chosen. It records one payment each, with one client id per payment, in one step (M14).
      - A cancelled order's deposit shows as "money back to the customer" until a refund is recorded.
    - **Reversal guards:** `sale.reverse` and `sale.correct` are refused while payments stand on the sale (`SALE_HAS_PAYMENTS`, B6).
    - **One sale** (Step 2) may now name a customer, and "They'll pay later".
    - **What customers owe** (`receivable.list`): one figure per obligation (A2).
      - The sale that a delivered order posted carries nothing owed: the order does.
      - Overpayments are shown.
      - No output field is named `balance` (contract test); it is `owed`.
    - **Purchases:** `purchasePayment.record` takes kind `refund` on an overpaid purchase, which settles its "Overpaid" (D-162). Money a member received counts against what the business owes them (D-181).
    - **Reports:** `profit.summary` gains "by order".
    - **Refresh (D-212):** deliveries, refunds and payments make Orders, What customers owe, the cards and profit stale.
    - **Keys:** `customers.items.view/manage`, `orders.documents.view/manage/deliver/reverse` and `payments.customers.view/record`. `orders.documents.view` needs `sales.documents.view` (H1).
  - **Screens:**
    - **Orders:**
      - **The list:** Pending first by due date, then Delivered and Cancelled; search by number, LPO or customer.
      - **The editor:**
        - a customer, with quick add and "Did you mean Ahmed · 050…?";
        - the items, the discount, and the customer's LPO;
        - delivery: yes → area, amount charged, what it cost;
        - the due date and notes;
        - "Paid now / Deposit", with its method;
        - attachments.
      - **The order:**
        - Deliver: its confirmation says "This counts as a sale on Thu 8 Oct: AED 170.00";
        - Record a payment, Refund, Cancel, Undo delivery;
        - a badge: Paid / Deposit paid / Not paid;
        - the order's profit, with the costs switch.
    - **Customers:** the list, then each customer's page with their orders, sales, payments and what they still owe.
    - **What customers owe** («مستحقات العملاء»), with the payment sheet.
    - **Dashboard:** Recent orders (as the mockup: #1001, item, amount, Pending/Delivered), What customers owe, Delivery margin.
    - **Reports:** Profit by order.
    - **Purchases:** on an overpaid purchase, "Record money back from the supplier". It ships at once (D3).
  - **By business type:**
    - home baker: WhatsApp, Instagram and phone orders with delivery, deposits and refunds;
    - maker: orders with deposits;
    - workshop: orders "from deposit to delivery";
    - factory: orders on credit with LPOs, invoiced in Step 8;
    - designer: One sale with "They'll pay later";
    - a shop without a POS: Orders, with the way out to Today's sales (§6.12 #3).
  - **Tests:**
    - the baker's order #1001 end to end, with its refund (definition of done);
    - deliver racing a payment and a cancel;
    - overpaying refused; undo delivery with closed books; deliver → undo → deliver again;
    - a refund of a deposit; money back from a supplier, also received by a member;
    - `numbering.concurrency.api.test.ts`:
      - 100 orders created in parallel are #1001–#1100;
      - a replayed create takes no number;
      - two businesses stay independent;
    - cross-tenant probes, the oracle (masked pickers included), pgTAP `25_orders_payments`;
    - `orders.spec.ts`: the baker in Arabic on a phone, the workshop in English on a desktop.
  - Depends on: Step 3. It does not need Step 4.

- [ ] **Step 6: Release A: Sales & Profit** (APPROVED; decision Q1; the owner reviews it, as after M2 Step 7).
  - **Manifests:** `sales`, `reports`, `customers`, `payments` and `orders` become `released`.
    - **Sidebar:** the group "Sales" holds Sales, Orders, Customers and What customers owe. "Reports" holds Real profit.
    - **The phone's tab bar,** through the D-189 claims (Q14): the owner gets Home | Sales | + | Costs | More. Orders takes the Sales place for an orders business, and Products moves to More.
    - **"+":** Today's sales, New sale, New order and New customer, each only for those who may enter it (D-195).
    - **Customize BizCost** drops "soon" for these modules.
    - **Smart Setup's reasons** now describe live modules (B17):
      - `reports.projects` no longer says "by project" (Phase 5);
      - `sales.invoices` is reworded while Invoices is "soon".
  - **Keys:** final, with a backfill migration for existing template roles and a new `permissions_version`. `settings.books.close` is offered with Sales or Orders on too (D-201).
  - **Capability audit:**
    - VAT fields only when VAT-registered;
    - the branch picker, By branch and "Branches they work in" only with branches;
    - "Entered by" only with a team;
    - delivery cost and fees only with the costs switch (or on one's own records);
    - no stock quantity anywhere.
  - **Demo data** per persona, entered through the API with months counted back from the seed day (D-101, D-185):
    - café: 2 branches with last month and this month so far imported, plus Talabat statements;
    - baker: orders with deposits, delivery and one refund;
    - maker: a marketplace import with fees, plus orders;
    - designer: one sale per job, some paid later;
    - factory: orders on credit with LPOs;
    - workshop: orders with deposits;
    - retail: a POS import matched by code;
    - fit-out: one sale per stage and job materials.

    `ledger.rebuild` and `costing-data.test.ts` stay green, and each persona shows its real profit.

  - **Tests:** `release-sales.spec.ts`:
    - nav, tabs and "+" per role;
    - the checklist from an empty café to its real profit;
    - phone and desktop, AR/EN.

    Every Release A spec runs on the production build.

  - Depends on: Steps 2–5.

- [ ] **Step 7: Quotations, document numbers and PDFs** (APPROVED; decisions Q21–Q25).
  - **Domain:**
    - `documents/billing.ts`: what an accepted quotation, or an order, has billed and has left, by % or by amount. Never above 100%; the last invoice bills exactly the rest (Q22).
    - **A typed line** counts in sales and carries its running-cost share, with no materials; profit says so (Q21).
  - **PDF service:** the engine chosen in Step 1 (Typst compiled to WebAssembly, D-224), inside `packages/api`, server-only, in a worker of the API function that is replaced as its memory grows; D-224 lists its Step 7 tests and the text-layer limits to try to fix.
    - **Text:** bilingual labels (Q23); names as typed, in `dir="auto"` isolates; TRN, LPO and numbers in LTR isolates (§13); Latin digits.
    - **Security:** user text escaped; JavaScript, network and file access off; PDFs and statements rate-limited.
    - **Quotation PDFs** are made on request.
    - **Storage:** a server-side upload helper joins `storage-admin`, with the documents service added to its lint allowlist. `file_uploads.purpose` gains `document` (PDF only), for Step 8's issued copies.
  - **Data:**
    - `quotations`:
      - a number from `document_counters` at creation (Q-0001…), `root_id` and `revision`. Quotation numbers may skip: a discarded draft keeps its number (Q25);
      - `status`: draft | sent | accepted | declined | superseded. "Expired" is derived from `valid_until`;
      - `customer_id` (required), `location_id`, `business_date`, `valid_until`, `customer_ref`;
      - discounts, the "Round the total" adjustment, the rounding difference, the totals and the VAT per rate;
      - terms and notes; `sent_at/by`, `accepted_at/by` with a note, `declined_at/by`; the `order_id` / `invoice_id` links.
    - `quotation_lines`: a product, or typed text (Q21), with description, quantity, unit, price, discount, VAT category and the amounts.
    - **Revisions:** a sent revision is frozen by a trigger. "Revise" makes revision n+1 under the same number, and the old one is kept as superseded.
    - **Attachment entities:** `quotation` (the customer's signed PDF, drawings) and `quotation_line` (a drawing for one item, owner spec 27). They extend `ATTACHMENT_ENTITIES`, `RECORD_TABLES` and `app.check_attachment_target`.
    - `businesses` gains:
      - `address_line`, `city` and `emirate`;
      - `trade_licence_no` and `trade_licence_authority` (B15);
      - a document footer (bank details, default terms).
  - **API:**
    - **Quotations:** `quotation.list/get/create/update/discard/send/revise/accept/decline/copy/toOrder/pdf/history`.
      - `history` is read from the status columns and revisions, with who and when from the audit log. It never returns row data from the log, and it is in the oracle (M11).
      - A repeated send or accept returns the recorded result.
    - **Document settings:** `document.settings` / `.updateSettings`: prefixes, first numbers and the footer. Each first number can be set once, before its series' first number.
    - **Keys:** `quotations.documents.view/manage/decide` and `settings.documents.manage` (Owner and Admin). No sensitive field: prices are not sensitive (D-187).
  - **Screens:**
    - **Quotations:** status filters and search by number or customer, kept in the address.
    - **The editor:** multi-column on a desktop, stacked on a phone.
      - The customer, with quick add.
      - Lines from Products & Services by type-ahead, or typed, with "Save as a work item".
      - % or amount discounts.
      - **"Round the total"** («تقريب الإجمالي»): type 1,100 and see the adjustment before VAT, and any "Rounding difference" («فرق التقريب»).
      - The VAT per rate (only when VAT-registered), terms, attachments (also per line).
    - **The quote:**
      - Send: a PDF download, or the phone's share sheet (WhatsApp, mail apps);
      - Revise; Mark accepted (with the signed PDF) or declined;
      - History; Copy;
      - Convert to an order (with Orders on). Convert to an invoice comes in Step 8.
    - **Settings → Documents.** Business profile: the address and the trade licence.
    - **The checklist** gains "Add your business address" for businesses with Quotations or Invoices on (D-090 rules).
    - **Wording:**
      - project businesses say "Services & work items";
      - Quotations stay off for cafés, retail and home bakers unless turned on (§6.6);
      - §13 gains "Round the total / تقريب الإجمالي" and "Rounding difference / فرق التقريب".
  - **By business type:**
    - fit-out and events: work items in m², revisions, extra work as a revision accepted again;
    - designer: service quotes;
    - workshop: a quote, then an order with a deposit;
    - garage: parts and typed labour.
  - **Tests:**
    - Round the total, through the API, with one rate and with two;
    - revisions keep their history; accept, then an order; counters under parallel creates;
    - a PDF golden:
      - «عرض سعر» and an Arabic customer name extracted in logical order;
      - the TRN `100123456700003` left to right;
      - 200 lines paginate, in under 1 s;
      - a name holding HTML or script is printed as text;
    - the hardening suites, including signed PDFs in Storage (direct-access);
    - `quotations.spec.ts` on the preview:
      - fit-out in Arabic on a phone: 3 lines, total rounded to 15,000.00, sent, revised, accepted with a signed PDF;
      - a workshop in English on a desktop.
  - Depends on: Step 5 (customers, counters); the Step 1 bake-off.

- [ ] **Step 8: Invoices, credit notes, payments on invoices and customer statements** (APPROVED; decisions Q26, Q27). First, the e-invoicing and VAT rules are re-verified. They were last checked on 2026-10-04 against MoF and FTA texts (§Open below).
  - **Data:**
    - `invoices`:
      - **Kind:** `kind`: tax_invoice | invoice (plain). It is set by VAT registration at issue and frozen (Q26). A tax invoice needs the business currency AED (VAT DL Art. 69).
      - **Number:** **a gapless number taken at issue** from the invoice series in `document_counters`, locked last in the issuing transaction (Q25). A replayed issue is answered before a number is taken. The number text and its integer are stored, with UNIQUE.
      - **Status:** `status`: draft | issued. An issued invoice is never edited, reversed or deleted. Only a credit note corrects it, even a full cancellation (VAT ER Art. 60).
      - **Dates:**
        - `issue_date` is the day of issue, so numbers and dates rise together;
        - `supply_date` is on or before today, the issue date by default;
        - `due_date`, `lpo_reference` (copied from the order);
        - `location_id`.
      - **Snapshots frozen at issue** (D-002):
        - the customer: name, kind, TRN, trade licence, address;
        - the seller: legal name, Arabic legal name, TRN, trade licence and authority, address.
      - **Links:** `quotation_id` / `order_id` / `sale_id`.
      - **Part invoices:** `bills`: everything | part (% or amount) | rest; `is_deposit` (Q22).
      - **Counting once:** `counted_elsewhere`: the required answer to "Is this sale already in your recorded sales (Today's sales, an import or your POS)?" (Q3). It is asked only when such sales exist and the invoice is not made from an order, a sale or a deposit. It is never preselected.
      - **Lines and totals:**
        - the lines (product optional), discounts, "Round the total", the rounding difference, the VAT per rate and the totals;
        - **deposit deductions:** on a final invoice, one line per VAT rate takes the deposit invoices' net off before VAT, each naming its deposit invoice (H8).
      - **Identity:** the id is the invoice's UUID (BTAE-07).
      - **The issued PDF:** `pdf_upload_id`, the issued PDF stored in `business-files`. It is rendered from the frozen invoice after the commit, so it can be rendered again identically if the first attempt fails.
      - **Attachment entities** `invoice` and `invoice_line` (B4).
    - `credit_notes` and `credit_note_lines`:
      - their own gapless series (CN-0001…);
      - the invoice, and `event_date`: the day the reason happened;
      - **a reason**, mapped to both lists:
        - VAT DL Art. 61(1) for tax credit notes today: cancelled; tax treatment changed; price changed; goods returned; tax charged in error;
        - MD 243 Art. 6(2) for e-credit notes later: cancelled; price reduced; price returned; error.

        It comes with text;

      - lines by quantity or by amount, never more than is left;
      - **kind:** "Tax Credit Note" for a tax invoice, "Credit Note" for a plain one (B5).
    - `customer_payments.invoice_id`.
    - `sales.source` gains `invoice` and `credit_note`.
    - **Guards:** the books-closed guard covers credit notes' sales and customer payments; pgTAP `26_documents`.
  - **Counting once (Q3):**
    - Issuing posts the invoice's sale on its date of supply, except:
      - an invoice made from an order: the delivery counts;
      - an invoice made from a recorded sale: that sale counts;
      - a deposit invoice: the final invoice counts the whole work, its net plus the deposit invoices' net;
      - an invoice answered "already in my recorded sales".
    - A credit note posts a negative sale on its own date, except on a deposit invoice. On an invoice counted elsewhere, it asks the same question.
    - **Closed books never block an issue (H5).** The issue date is today. Only the sale it posts moves to the first open day, with a note on the invoice. When the books are closed through today, the issue waits for them to open (D-135).
  - **What is owed (A2):** once an order or a sale has an issued invoice, what is owed lives on its invoices. The order's or sale's payments count toward them, oldest first; a deposit paid on the order pays the deposit invoice first.
    - `sale.reverse` and `order.undoDelivery` are refused while an issued invoice refers to them (`SALE_HAS_INVOICE`).
  - **API:**
    - **Invoices:** `invoice.list/get/create/update/discard/issue/pdf/history/fromQuotation/fromOrder/fromSale/copyToQuotation`.
    - **Credit notes:** `creditNote.list/get/create/update/discard/issue/pdf/history`.
    - **Payments:** `customerPayment.*` and `receivable.list` gain invoices: still owed = total − credit notes − payments.
    - **Statements:** `customer.statement` covers a period: owed at the start, documents, payments, and owed at the end. It is also given as a PDF (Q27).
    - **Issuing a tax invoice needs** (B16, C5):
      - the business's address and TRN;
      - for a VAT-registered customer, their name, address and TRN (ER Art. 59(1)(c)).

      For a business customer without an address line, city and emirate, a warning names PINT-AE IBR-144-AE, which binds from the connector milestone. It does not block the issue.

    - **Keys:** `invoices.documents.view/manage/issue/credit`.
  - **Screens:**
    - **Invoices:** draft, issued, partly credited, credited, owed, overdue (derived from the due date); search by number, LPO or customer.
    - **The editor:**
      - starts from scratch, or from a quote, an order or a sale;
      - LPO and due date;
      - "This invoice bills: everything / part (% or amount) / the rest";
      - the required "already in your recorded sales?" question, where it applies;
      - a draft whose date of supply is more than 14 days old gets a note: "A tax invoice is due within 14 days of the supply" (VAT DL Art. 67(1)).
    - **Deposits without a tax invoice** (M6): a VAT-registered business sees each deposit recorded without its tax invoice, with its 14-day deadline, on Invoices and under "Needs a look".
    - **Issue:** the confirmation says that the number is taken and the invoice can't be edited after ("To fix it, you'll issue a credit note").
    - **The invoice:** PDF download or share, Record a payment, Credit note, Copy to a quotation, History.
    - **The credit note sheet:** the reason, the event date, and a warning when the event is more than 14 days old: "A tax credit note is due within 14 days" (VAT DL Art. 62(2), as amended by FDL 18/2022).
    - **Statements:** a customer's page → Statement → a period → PDF.
    - **Before the first tax invoice,** a note leads to "Add your TRN and address".
    - **Document titles:**
      - "Tax Invoice / فاتورة ضريبية" (ER Art. 59(1)(a));
      - "Tax Credit Note / إشعار دائن ضريبي" (ER Art. 60(1)(a) as amended by CD 149/2026), with the Arabic taken from the Arabic ER text;
      - a plain "Invoice / فاتورة" and "Credit Note / إشعار دائن", never the word "tax".
      - §13 records them beside the supplier's credit note «إشعار تخفيض» (D-120).
  - **By business type:**
    - fit-out: a full tax invoice and a tax credit note, and 30 / 40 / 30 stage invoices of another accepted quote;
    - factory: orders, then tax invoices with LPO numbers per site and a monthly statement;
    - designer: a plain invoice with no VAT, made from her recorded sale;
    - workshop: a deposit tax invoice, then the final invoice;
    - café: a B2B tax invoice for a catering order, already in its recorded sales.
  - **Tests:**
    - `invoices.numbering.concurrency.api.test.ts`:
      - gapless under contention and under replays;
      - a refused issue takes no number;
      - credit notes have their own series;
    - VAT per rate (S-09) and IBR-147-AE on every issued invoice: a property through the API;
    - deposits: deposit VAT + final VAT = VAT on the work (a property);
    - credit notes never above what is left; a plain invoice never says "Tax Invoice" or VAT;
    - the 12 particulars of ER Art. 59(1) in the PDF text;
    - stage invoices add up to the quote; counting once; one owed figure;
    - `einvoice-readiness.api.test.ts`: each PINT-AE field BizCost owns maps to a column. The rest are named as connector-milestone fields: TIN derivation, buyer legal id types other than a trade licence, and others;
    - closed books, the oracle, cross-tenant;
    - `invoices.spec.ts` on the preview: fit-out in Arabic on a desktop, the designer in English on a phone, the factory's statement.
  - Depends on: Step 7.

- [ ] **Step 9: Release B: Quotations & Invoices** (APPROVED; the owner reviews it).
  - `quotations` and `invoices` become `released`.
    - Their keys are backfilled, and they get their nav.
    - "+" gains New quotation and New invoice.
    - Customize drops "soon".
  - **Customer statements** appear on customers' pages for every business with Customers on, orders-only ones included (B10).
  - **The phone's tab bar:** for a business that invoices without orders (designer, fit-out, garage), Invoices takes the phone's Sales place (Q14).
  - **Capability audit:** tax or plain documents by VAT registration; branches; team.
  - **Demo data:**
    - fit-out: a quote with a revision, a full invoice, a credit note, and a second quote with three stage invoices;
    - factory: orders, invoices and a statement;
    - designer: quotes, and plain invoices from her sales;
    - workshop: a quote, an order, a deposit invoice and the final invoice;
    - café: a catering invoice.
  - `release-documents.spec.ts` runs on the production build.
  - Depends on: Steps 7–8.

- [ ] **Step 10: Hardening & docs** (APPROVED; as M2 Step 8).
  - **The suites cover every M3 procedure:**
    - cross-tenant, on every reference field;
    - direct-access: issued PDFs and signed quotes in Storage, signed URLs;
    - `gates`: module-off scenarios (including Sales off in Customize), capability gates by field, and branch limits;
    - `inputs`: Arabic-Indic digits in every decimal field, imports included;
    - the redaction oracle × 7 templates + member overrides, with every query and group field classified;
    - `sales-visibility`, audit coverage, access refresh, `no-stock` and the contract test.
  - **Concurrency:**
    - deliver vs payment vs cancel;
    - an import post (and replace) vs a purchase filling missing costs;
    - a sale reversal vs a fill;
    - gapless issue under contention and replays;
    - a sale reversal racing a payment.
  - **pgTAP:** books-closed and immutability for every new posted table (sales, invoices, credit notes, payments, statements), the fill-once columns, and the composite FKs (`27_m3_links`).
  - **e2e:** `m3-smoke.spec.ts` (every M3 screen and state, AR/EN at 375, 768 and 1440 px, `auditScreen`, `RAW_KEY`) and `m3-done.spec.ts`.
  - **Budgets:** a year of a two-branch café in Reports; a month of line files imported; a PDF in under 1 s.
  - **Closing work:**
    - an adversary review (PDF rendering of hostile text, D-209 oracles through fills and imports), its fixes and the review of those fixes, each with its failing test kept;
    - the five docs:
      - PRODUCT §7 (phases confirmed), §8 (templates), §9, §10, §11 (plain invoices, credit notes, dates re-checked) and §13 (terms);
      - ARCHITECTURE (sales model, lock order with the fill edge, numbering, PDF, import);
      - DATA_MODEL §6;
      - DECISIONS;
      - this file's §Open;
    - `pnpm dev:clean-test-data` after the heavy runs.
  - Depends on: Step 9.

### M3 out of scope

- **Phase 4 (Control):**
  - stock taken out by sales, stock screens and counts, `first_stock_count_at`, and the negative-stock rule (it arises only once sales take stock out, Q5);
  - expected vs actual usage, waste and unexplained usage, variance alerts;
  - recipes for modifiers, sub-recipes and batches;
  - a Packaging card (it needs a kind of material);
  - running-cost rates per branch.
  - M3 keeps `sale_line_materials`, which Phase 4 reads.
- **Phase 5 (Operations):**
  - labour by employee, and running costs by working time; machine cost per hour;
  - Projects (project profitability) and Jobs & Tasks (cost per job, the materials of one job). Stage invoices ARE in M3, as part invoices of a quote (Q22); retention invoices wait for Projects;
  - an expense tied to an order, job or project (Q20);
  - VAT Center (credit notes' VAT is reported there later); petty cash and payroll.
- **Phase 6 (Intelligence):**
  - POS and platform APIs, scheduled syncing, files forwarded by email;
  - OCR of end-of-day reports, AI column mapping;
  - benchmarks, advanced analytics, and exports of reports to CSV or Excel (redaction will cover exports when they come).
- **The e-invoicing connector:** the ASP adapter, PINT-AE XML, status messages and retries through an outbox, and suppliers' e-invoices received into Purchases. It gets its own milestone right after M3 (Q24). M3 builds only the cheap fields now: UUID, addresses, customer kind, trade licences, VAT per rate and credit reasons.
- **Later, not planned:**
  - **Orders:** partial delivery of an order (until then, edit the pending order down and enter a second one); purchase orders.
  - **Imports:** ready-made POS presets until real sample files exist.
  - **Invoices:** simplified tax invoices (Q26), other currencies, recurring invoices, reminders, payment links.
  - **Suppliers:** supplier statements and a supplier credit balance (Q18, Q27); the "copy from supplier" helper (D-112).
  - **Customers:** customer credit kept on account (Q17); a customer portal or online acceptance.
  - **Documents:** emailing documents from BizCost (Q23); a cost and profit estimate while quoting (say so if wanted).
  - **Settings:** a week-start setting; business deletion screens (their rule is in §Open).
  - **Platforms:** mobile apps and the hosted deploy (DEFERRED by the owner).

### M3 definition of done

Each item gets named tests as evidence when built (Step 10). Every number is worked out by the domain and checked end to end, in Arabic and English.

- [ ] **The café's September, end to end.** Running costs and expenses of AED 20,000 ÷ item sales of 80,000 before VAT = 25%. The café's prices are before VAT.
  - An AED 18.00 Spanish Latte carries 4.50. With its materials at 3.002034632035 (shown 3.00), it earns **10.50** dine-in.
  - On Talabat:
    - with only Talabat's commission % of 20%, it carries 3.60 in fees;
    - once the September statement is posted (fees 1,800 ÷ Talabat sales 10,000 = 18%), it carries 3.24 and earns **7.26**.

    Dine-in carries no app fees.

  - The business: 80,000 − materials 24,000 − fees 1,800 − running costs 20,000 = **real profit 34,200 (42.75%)**. It shows on the Dashboard, in Reports by month, week, product, channel and branch, and on Product costs ("25% of its price, September 2026").
  - The shares of a finished month add up to 20,000 exactly at 25%. At 20,000 ÷ 30,000 they add up within the 12-decimal tolerance, and the business total subtracts exactly 20,000, with "not carried by sales" at 0.00.
  - A Talabat statement for 16 Oct–15 Nov with fees of 2,480 counts 1,280 in October (16 days) and 1,200 in November (15 days).
  - Talabat's commission tax invoice entered as an expense marked "App fees of Talabat" counts once, never also in running costs.
- [ ] **Today's sales.** A café's sheet for 8 Oct: 40 lattes × 18.00 + 25 croissants × 9.00 = 945.00 before VAT, VAT 47.25, total 992.25, typed in Arabic-Indic digits on a phone.
  - Two members' sheets for the same day add up, and the manager sees "2 sheets".
  - A home business's sheet for 1–30 Sep posts one sale dated 30 Sep, "covers 1–30 Sep".
- [ ] **The home baker's order #1001.**
  - A chocolate cake at 150 plus delivery charged 20, with a deposit of 50 by bank transfer, leaves **still owed 120**.
  - Delivered on 14 Sep, it counts as a sale of 170 on that day. The delivery cost 25, so the delivery margin is −5 ("you paid 5 of the delivery").
  - Once September is over, with its 1,000 ÷ 4,000 = 25%, materials of 32.40 and her 60 minutes at AED 40/h, the order's **real profit is 35.10**.
  - Paid in full, then refunded 20 by amount for a damaged cake:
    - September's sales from it are 150;
    - its materials stay 32.40, since a price cut takes back no cost;
    - its real profit is **20.10**;
    - with the refund payment of 20, nothing is owed.
  - Undo delivery on 15 Sep takes the 170 out of September; delivering again on 16 Sep counts it on the 16th.
  - A cancelled order with a deposit of 50 shows "money back to the customer: 50" until the refund is recorded.
  - There is no VAT field anywhere (not registered).
- [ ] **The running month and a first month.**
  - On 10 October, an October latte carries 4.50, "at September's rate until October ends". The business's October profit subtracts its costs so far, not the whole month's.
  - A business whose first sale is on the 1st of a 30-day month:
    - on the 15th, its month's rent bill of 6,000 counts 6,000 × 15 ÷ 30 = 3,000 so far; with sales so far of 12,000, it uses **25% "so far"**;
    - on the 4th, it says "before running costs" (fewer than 7 days of sales), not 800 ÷ 1,000 = 80%.
  - With Running Costs and Expenses off, the state is `off`, and the total says so.
- [ ] **The cost of what was sold is frozen on its day** (Q5).
  - A latte sold on 3 Oct keeps 3.002034632035 after a milk purchase on 5 Oct, and after a September purchase is reversed.
  - A purchase dated 1 Oct but posted after the sale is not in it.
  - **A sale entered before any purchase:**
    - it shows "no price yet" (never 0), and real profit says "incomplete";
    - the first purchase fills it once, even when it posts at the same moment as the sale, and also into a closed month;
    - it never changes after that.
  - No sale or import is ever refused for stock. No answer holds a stock quantity, and the stock ledger is unchanged by sales.
- [ ] **Nothing counts twice** (Q3).
  - A factory order of 10,000 delivered on 15 September and invoiced on 20 September makes September's sales 10,000, not 20,000.
  - The designer's One sale of 2,000 ("they'll pay later"), then invoiced from that sale, makes her month's sales 2,000. What she is owed moves to the invoice.
  - A café's catering invoice answered "already in my recorded sales" adds 0. The question is never preselected.
  - A deposit invoice adds 0, and the final invoice adds the whole work.
  - A credit note lowers the sales of its own month.
  - **Imports:**
    - the same file imported twice is refused;
    - overlapping days are skipped by default, or replaced on request;
    - Today's sales and an import for the same channel and day get a warning.
- [ ] **Import.**
  - A Loyverse-style file with Arabic headers and Arabic-Indic digits, "لاتيه إسباني ١٢٠ ٢٬٢٦٨٫٠٠" including VAT, gives 120 lattes at **2,160.00** before VAT (18.00 each).
  - "Spanish Latte L" is offered as "Did you mean Spanish Latte?", and the answer is remembered the next time.
  - A Windows-1256 CSV reads the same as UTF-8.
  - **The maker:** a noon-style line file with a fee column gives profit per product after fees. Its fees become the channel's statement for the file's period.
  - **Retail:** a POS file is matched by item code. Finalize is refused while a row is unmatched.
  - No file is stored, and no customer name or phone leaves the browser.
  - 2 branches × 31 days × 120 products post in under 5 s.
- [ ] **Materials no product uses** (Q13 A). A fit-out company's month: running costs 20,000, gypsum bought for a job 4,000 (in no recipe), sales 80,000 → (20,000 + 4,000) ÷ 80,000 = **30%**. "Needs a look" lists the gypsum as "bought but in no recipe".
- [ ] **Document maths.**
  - 7 lines of 10.10 at 5% → VAT **3.54**, not 3.57 (lines 4 × 0.51 + 3 × 0.50), total 74.24.
  - "Round the total" 1,120.00 → 1,100.00: adjustment −19.05 before VAT, VAT 52.38.
  - Mixed rates, 2,000 (5%) + 500 (0%) = 2,600.00 → 2,500.00: −76.92 and −19.23 before VAT, VAT 96.15.
  - 1,000.12 at 5% → 1,000.11 + a rounding difference of 0.01.
- [ ] **The fit-out company's tax invoice.** INV-0001 is issued from accepted quotation Q-0001.
  - **Lines:**
    - gypsum partition 120 m² × 45.00 = 5,400.00;
    - painting 300 m² × 18.00 = 5,400.00;
    - labour 5 days × 650.00 less 10% = 2,925.00.
  - **Totals:** net 13,725.00, VAT 686.25, **total AED 14,411.25**.
  - **The PDF** shows:
    - the 12 particulars of VAT ER Art. 59(1);
    - "Tax Invoice / فاتورة ضريبية";
    - both TRNs left to right;
    - Arabic correctly shaped in the text layer.
  - **A credit note** for 100 m² of painting (1,800.00 + VAT 90.00) issues CN-0001 with its reason and event date. The invoice then says "credited 1,890.00, still owed 12,521.25". The invoice itself is never edited.
  - A credit note whose event is 15 days old shows the 14-day warning.
- [ ] **Stages and deposits.**
  - **Stages:** 30 / 40 / 30 of another quotation of 10,000.00 + VAT give 3,150.00, 4,200.00 and 3,150.00, the last billing exactly the rest.
  - **The workshop's order** of 20,000 + VAT = 21,000, with a deposit of 5,250 recorded on the order:
    - a deposit tax invoice of 5,000 + 250, paid by that deposit;
    - then the final invoice: 20,000 − 5,000 deposit = 15,000 + VAT 750 = **15,750.00**. VAT is charged 1,000 in all, once.
    - "What customers owe" shows 15,750 once, and the statement lists the invoices only.
  - **Deposits without a tax invoice:** a deposit recorded on 1 Oct without its tax invoice is listed until it has one, "due by 15 Oct".
  - **Not VAT-registered:** such a business issues an "Invoice" and a "Credit Note", with no VAT anywhere and no word "tax".
- [ ] **Gapless numbering.**
  - 50 invoices issued at once by 5 members get INV-0001 to INV-0050, none missing and none twice. Replayed issues take no number.
  - A discarded draft and a refused issue (a missing TRN of a registered customer) take no number. An issue whose supply day is in closed books is issued, and its sale posts on the first open day.
  - A business that set its first number to 457 continues 457, 458…
  - Credit notes have their own series. Quotation and order numbers may skip, and say so.
- [ ] **What customers owe, and statements.**
  - The factory's customer has invoices of 5,250, 3,150 and 2,100. "Pay several at once" of 8,000 settles them oldest first and leaves **2,500** owed.
  - The September statement shows opening 0, invoiced 10,500, paid 8,000 and closing 2,500, as a PDF in Arabic.
  - Overpaying is refused. The payment method is required and never preselected.
  - A purchase overpaid by 200 after a credit note is settled by "money back from the supplier" of 200. Received by a member, the 200 lowers what the business owes them.
- [ ] **Who sees what** (redaction oracle: every procedure × 7 templates + overrides).
  - **The Employee** enters Today's sales and orders, sees only their own, and may see a delivery cost they typed. They never see another cost, a fee, a profit or a business total. Their customer picker shows names and the phone's last 4 digits.
  - **Supervisor and Sales** see every sale and the sales totals, and no profit. **Accountant** sees profit.
  - **A custom role** with the costs switch and profit reports, but without running costs, sees the month's running-cost total in Real profit and never its categories.
  - **A member limited to one branch** sees and enters only that branch's sales.
  - Grouping, sorting, filtering or searching by a hidden value is FORBIDDEN. No answer, error or failing post depends on a hidden value (D-209).
- [ ] **Capabilities, releases and screens.**
  - **Capabilities:**
    - VAT fields only when VAT-registered;
    - the branch picker and By branch only with branches;
    - "Entered by" only with a team;
    - no stock quantity in any answer (`no-stock`, contract test).
  - **Releases:** only released modules appear. Quotations and Invoices stay "soon" until Release B, and released businesses see no M3 change before Release A except "Money back from the supplier".
  - **Screens:** every M3 screen works in AR and EN at 375, 768 and 1440 px.
- [ ] **Budgets.** Locally:
  - `profit.summary` over a year of a two-branch café: under 1 s;
  - a 2-page invoice PDF: under 1 s warm;
  - 2 branches × 31 days × 120 products imported: under 5 s;
  - a 50,000-row line file: under 10 s.
- [ ] **Ready for the e-invoicing connector.** Each issued invoice and credit note holds a UUID and **the PINT-AE fields BizCost owns now**:
  - the seller's and buyer's names, kind, TRN, trade licence and address with emirate;
  - dates and lines;
  - VAT category and rate, totals per rate and the rounding difference;
  - the credit reason.

  The readiness test maps the remaining PINT-AE fields to the connector milestone.

- [ ] **Final runs.** `pnpm check`, `pnpm db:test`, `pnpm api:test`, `pnpm e2e` and the bundle check pass. `pnpm demo:seed` shows each persona's real profit, quotes and invoices.

### Owner actions for M3

| Action                                                                                                                                                               | Needed by                                             | Notes                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real sample export files from businesses he knows: Foodics (Orders, Order Items), Loyverse, Sapaad, Odoo; Talabat, Deliveroo, Careem, noon Food and Keeta statements | Step 4 (better tests); before any POS preset          | The general importer works without them. Names and phones are removed before a file becomes a test fixture; the originals are never committed and are deleted after |
| A tax invoice and quotation layout he likes (photo or PDF)                                                                                                           | Before Step 7                                         | Goes into `docs/mockups/`                                                                                                                                           |
| A UAE tax agent or accountant looks at the tax invoice and credit note PDFs (titles, Arabic wording, particulars)                                                    | Release B review; required before the first real user |                                                                                                                                                                     |
| Shortlist a partner ASP and ask for ISV terms: sub-accounts per business, sandbox, webhooks, inbound invoices, the 100 free invoices a year (MD 64/2025)             | Dec 2026 (Q24)                                        | Candidates with public APIs, all on the MoF register of 02/10/2026: Complyance, Fynamics, Casim, Flick Network, ClearTax. Claude never creates the accounts         |
| Resend sending domain (existing row)                                                                                                                                 | Only if Q23 = C                                       | Not needed for M3                                                                                                                                                   |

## Owner decisions (M3)

Answer as "1أ-2أ-3ب…", or "all as recommended, except…". Each deadline is the step that needs the answer.

| ID  | Question (simple words)                                                            | Options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Recommendation (why)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Deadline                    |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Q1  | Release Sales & Profit before Quotations & Invoices?                               | **A)** Two releases: Sales, Orders, Customers, payments, import, real profit and reports at Step 6; Quotations & Invoices at Step 9. **B)** One release at the end, as in M2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **A**: every business sees its real profit about half-way, without waiting for invoices                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | With the milestone approval |
| Q2  | Customers                                                                          | **A)** Customers and Payments are confirmed as Phase 3 modules (Release A needs them). Names may repeat: a new one that matches shows the others first ("Did you mean Ahmed · 050…?"). A customer has a kind (person, business, government), phone, email, TRN and an address with emirate (asked only with Invoices on), and a business customer's trade licence. Staff who may not see customers pick them by name and the phone's last 4 digits. **B)** One customer per name, like suppliers                                                                                                                                                                                                                                                                            | **A**: many customers share names, the phone tells them apart, and a tax invoice needs the buyer's kind, TRN and address                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | With the milestone approval |
| Q3  | When does something count as a sale, once?                                         | **A)** On the day it is supplied: Today's sales and One sale when finalized; an order when delivered (a deposit is a payment, never a sale); an invoice on its date of supply, except one made from an order or a recorded sale (that counts already), a deposit invoice (the final invoice counts the whole work), or one you answer "already in my recorded sales" (Today's sales, an import or your POS; a required question, never preselected). A credit note lowers sales on its date. A quote never counts. **B)** Orders count when taken. **C)** Only invoices count (orders count once invoiced)                                                                                                                                                                  | **A**: each sale counts once, dated as VAT dates it; it works for the baker who never invoices and for the factory and designer who invoice what they recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Before Step 1               |
| Q4  | How VAT and "Round the total" are worked out on what you sell                      | **A)** VAT once per VAT rate on the document's total, then shown per line so the lines add up. "Round the total" adjusts before VAT, split over the rates by their amounts; a fils it can't reach goes to a "Rounding difference" of at most 0.02 (BizCost's limit). **B)** VAT per line and added up, as on purchases. **C)** As A, but when the exact total can't be reached, offer the two nearest totals                                                                                                                                                                                                                                                                                                                                                                | **A**: e-invoicing requires each rate's VAT to equal its total × the rate (7 lines of 10.10 give 3.57 per line, 3.54 on the total). Purchases stay as they are                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Before Step 1               |
| Q5  | The cost of what was sold, and stock, until you count your stock (Phase 4)         | **A)** Frozen when the sale is finalized: each material at its 90-day purchase average as of the sale's day (D-115). A material with no price yet is filled once by the first purchase that prices it, even in a closed month, then never changes. Sales don't touch stock until your first stock count in Phase 4, which starts your stock at that day's average (so costs don't jump). Nothing is refused for stock; negative stock is decided with Phase 4. **B)** As A, and each sale also takes its materials out of the hidden stock records at the running average, going below zero when needed. **C)** Worked out again each time it is shown (past months change when purchases are entered or corrected)                                                         | **A**: the cost of what was sold never moves once set, imports stay fast and never fail, and Phase 4 reads each sale's frozen recipe. Honest note: a past month's running-cost share, app fees and late bills can still change until its books are closed. A changes these technical notes, recorded as one new decision: D-115 (the first count resets the stock to that day's average), D-109 (no issues from sales in Phase 3), D-114 rule 3 and P-001 rule 3 (no correction on a reversal, since nothing was issued), D-208 (a sale never ends a run), D-120 (the "goods already used" part never triggers before the first count), and P-001's negative-stock question (moves to Phase 4) | Before Step 1               |
| Q6  | Which month's running costs go into real profit? (D-202's rule stays)              | **A)** A finished month uses its own costs ÷ its own sales (exact). The running month and Product costs use the last full month's rate, and say so; the business's profit for the running month takes off its costs so far. A first month (the month of your first sale) counts its costs from that sale, so far, and shows a rate once 7 days of sales exist. One rate for the whole business: By branch uses it and says so. **B)** The running month always uses its costs so far ÷ its sales so far. **C)** The average of the last 3 full months                                                                                                                                                                                                                       | **A**: a number from the first week, steady during the month, exact once each month ends, and never 2,400% on day 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Before Step 1               |
| Q7  | Without a team: is your time taken out of real profit?                             | **A)** Yes, at your hourly rate, as in product costs (D-119), on its own "Your time" line, so what you took home = real profit + your time. A sale entered before you set your rate gets it once, when you set it. **B)** No: real profit before your time, with your time shown beside it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **A**: the same rule as product costs; the time line keeps it honest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Before Step 1               |
| Q8  | App and selling fees (Talabat, Deliveroo, noon…)                                   | Fees stay with their channel, never in running costs (otherwise dine-in sales would carry Talabat's commission). **A)** A channel may have the commission % from your contract, used until a statement for the period replaces it; an expense you mark "App fees of Talabat" (for its VAT) counts as that month's fees and never in running costs; a courier bill can be marked "Delivery already on my sales and orders". Note: you said «ما نحطله خانه» (no cost field to fill); this % is the one optional figure you type, a fact from your contract like a price, not an estimate. **B)** No % to type (the strict reading of your rule): statements and marked expenses only, and "before app fees" until one arrives. **C)** Fees as expenses, shared over all sales | **A**: profit per channel from day one, exact once the statement is in, nothing counted twice. Card fees on your own machine stay in expenses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Before Step 1               |
| Q9  | How a business without a POS enters its sales                                      | **A)** "Today's sales": a sheet with your products, − / + and the price filled in, for one day or for several days within one month (typing a week or a month at once posts one sale on its last day, "covers 1–30 Sep"); and "One sale" for a job or one customer. Every line names something you sell (add it on the spot); no lump sums. **B)** Also a lump-sum "other sales" amount (it counts, but has no cost, so profit says "incomplete")                                                                                                                                                                                                                                                                                                                           | **A**: product profit, and Phase 4's usage, need the products; the period sheet covers the mockup's "monthly sales"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Before Step 2               |
| Q10 | Who can do what with the new modules (table below)                                 | **A)** As in the table. Staff enter and finalize today's sales and orders and see only their own. Each member has their own Today's sales sheet (added up, and managers see "2 sheets for Shop"). Staff may type the delivery cost they paid and see it on their own records. Whoever sees every sale sees the sales totals (adding up the list gives them anyway). No profit without the costs switch. **B)** Staff enter nothing; only the owner and managers record sales. **C)** One shared sheet per day, and staff see every sale                                                                                                                                                                                                                                     | **A**: the person at the counter records, the owner sees the money, and nothing is hidden that a list would reveal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Before Step 2               |
| Q11 | Who sees the business's real profit, and the costs it reveals (D-203)              | **A)** Real profit needs "See profit reports" plus the costs switch and "See product costs". It shows the month's total running costs (in "where the money went" and in its explanation); the categories (salaries…) stay with "See running costs" and "See expenses". **B)** The business's real profit and its running-cost total also need "See running costs" and "See expenses"; without them, profit by product still shows, and the business total says "Running costs: hidden"                                                                                                                                                                                                                                                                                      | **A**: a manager with the costs switch sees the profit the business makes; who earns what stays hidden                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Before Step 2               |
| Q12 | Limiting staff to their branch (only with branches)                                | **A)** A member's page gets "Branches they work in" (all by default). A member limited to branches sees and enters sales, orders, imports and reports only for those branches; products, customers and costs stay business-wide. **B)** Not in M3: everyone works across all branches (Employees still see only their own records)                                                                                                                                                                                                                                                                                                                                                                                                                                          | **A**: D-191 kept this screen for "a module used per branch", which Sales is; the rules engine exists (D-054)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Before Step 2               |
| Q13 | Materials no product or service uses (gypsum for one job, wood for a custom order) | **A)** They count with the month's running costs, shared by price, in the month bought; materials in recipes stay each item's own line. A big purchase raises that month's rate; costs per job come with Projects and Jobs (Phase 5). "Needs a look" lists them, so you can add them to a recipe instead. **B)** Not counted: the business's real profit shows "Materials bought this month that nothing sold uses: AED X" and says it is before them. **C)** Work items get recipes (e.g. boards per m²), and nothing else counts                                                                                                                                                                                                                                          | **A**: everything you buy counts once, as you asked («شامل كل شي»), and fit-out and workshops get an honest profit now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Before Step 3               |
| Q14 | Dashboard chart and cards, exports, phone tabs                                     | **A)** One chart, "Sales and real profit by day", drawn by BizCost (no chart library). "Low margin" = real margin under 10%; "Cost increases" = a material whose average rose 10% or more in 30 days, among those in what sold. No exports in Phase 3 except documents and statements as PDFs. Phone tabs: Home \| Sales (Orders for an orders business, Invoices for one that invoices without orders) \| + \| Costs \| More; Products moves to More. **B)** Numbers only, no chart. **C)** A chart library and Excel exports of reports                                                                                                                                                                                                                                   | **A**: the mockup's main chart without a new dependency; exports need their own redaction work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Before Step 3               |
| Q15 | Importing sales from a file                                                        | **A)** The file is read on your device and never kept: only its fingerprint, the column choices and the counts are. Names not found are settled before «اعتمد نهائيًا» (match, add as new, or "not something I sell"), and each answer is remembered. Days already imported are skipped by default, with "replace" offered. The same file twice is refused. Tips are not sales; a service charge is; delivery charged goes to the delivery margin; a fee column becomes the app's statement. **B)** Allow finalizing with unmatched rows (no cost, profit "incomplete"). **C)** Keep the original file for 90 days                                                                                                                                                          | **A**: no customer data kept, no double counts, and profit never inflated by items at zero cost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Before Step 4               |
| Q16 | An order's steps                                                                   | **A)** Pending → Delivered (it counts) or Cancelled; "Undo delivery" puts it back. Payment is shown apart: Paid / Deposit paid / Not paid. Refunds by quantity or amount after delivery. **B)** New → In progress → Ready → Delivered (steps may be skipped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **A**: matches the mockup (Pending / Completed), with nothing to keep moving                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Before Step 5               |
| Q17 | Customer payments                                                                  | As supplier payments (D-159, D-160): the method is required and never preselected; part payments and deposits; never edited (a mistake is reversed); never more than is owed. **A)** One payment per order, sale or invoice. "Pay several at once" records one each in one step, oldest first. Once an order or sale is invoiced, what is owed moves to its invoices and its payments count toward them; money given back is recorded as a refund. **B)** One customer account: payments without a document are kept as credit and used first by later invoices                                                                                                                                                                                                             | **A**: simple, the same as Amounts owed, owed once, and it covers deposits and monthly accounts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Before Step 5               |
| Q18 | Money a supplier owes you back after a return or credit note (§Open, D-162)        | **A)** "Money back from the supplier", recorded on the overpaid purchase, settles its "Overpaid"; when a member received it, it lowers what the business owes them. **B)** A supplier credit, used first by your next payments to them. **C)** Leave it as today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **A**: the smallest change that closes the loop with the cash that actually comes back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Before Step 5               |
| Q19 | The word for orders                                                                | **A)** "Orders / الطلبات" in every wording profile. «أمر عمل» stays the word for a job, which comes with Jobs & Tasks in Phase 5 (§6.12 #5 unchanged). **B)** Workshops and factories call their orders «أوامر العمل»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **A**: one word until jobs exist; Phase 5 decides "orders vs jobs" (§6.12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Before Step 5               |
| Q20 | An expense for one order (a special topper, a courier)                             | **A)** Not in M3: an order carries its delivery cost, packaging is in recipes, and job materials follow Q13. Direct costs per job come with jobs and projects (Phase 5). **B)** In M3: an expense can name an order; it counts in that order and leaves running costs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **A**: no speculative feature; the big direct cost (delivery) is covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Before Step 5               |
| Q21 | Typed lines on quotes and invoices                                                 | **A)** A line is picked from Products & Services, or typed (with "Save as a work item"). A typed line counts in sales and carries its running-cost share, with no materials, and profit says so. **B)** Every line must be a saved product or service (added on the spot)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **A**: fit-out companies, workshops and garages price custom work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Before Step 7               |
| Q22 | Stage invoices, deposits and extra work                                            | By law, a VAT-registered business that receives a deposit issues a tax invoice for it within 14 days, and the final invoice covers the rest. **A)** An invoice can bill part of an accepted quote or an order (% or amount), and the last one bills the rest. A deposit gets its tax invoice; the final invoice takes the deposit off before VAT, so VAT is charged once. "Deposits without a tax invoice" lists each one with its 14-day deadline until it has one. Extra work is a new revision of the accepted quote, accepted again. Retention waits for Projects. **B)** Full invoices only in M3; stages come with Projects in Phase 5. **C)** As A, plus retention invoices now                                                                                      | **A**: covers fit-out stages and workshop deposits without building Projects early, and no deposit is forgotten                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Before Step 7               |
| Q23 | Quote and invoice PDFs: language and sending                                       | **A)** Arabic and English labels together on one page, item names as typed. Sent by download or the phone's share sheet (WhatsApp, mail apps); email from BizCost comes with the hosted deploy. **B)** The business picks Arabic or English. **C)** Also email from BizCost now (needs the Resend domain; until then emails only reach the local test inbox)                                                                                                                                                                                                                                                                                                                                                                                                                | **A**: works now, with no mail domain, and one document fits every customer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Before Step 7               |
| Q24 | Connecting to e-invoicing (ASP)                                                    | Re-checked on 2026-10-04: under AED 50M revenue, a business appoints an ASP by 31 Mar 2027 and goes live on 1 Jul 2027 (MD 244/2025 Art. 5; MD 66/2026 moved only the AED 50M group, to 30 Oct 2026 and 1 Jan 2027; the MoF said on 30 Jun 2026 that no further extensions will be granted). Sales to consumers are outside it; B2B sales of businesses not registered for VAT are inside it. **A)** M3 issues PDF invoices and stores the fields e-invoicing needs that BizCost owns. The connector is its own milestone right after M3, after you choose a partner ASP by Dec 2026, live before 31 Mar 2027. **B)** Build it inside M3 (needs a signed ASP first, and delays the release). **C)** Don't plan it yet                                                       | **A**: nothing waits on a contract, and the connector still lands before the deadline that matters for our users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Before Step 7               |
| Q25 | Document numbers                                                                   | **A)** Invoices and credit notes: one gapless running series each per business, never reset: INV-0001…, CN-0001…. The prefix can be edited, and the first number is set once before the first invoice (to continue from an old system). Quotations (Q-0001…) and orders (#1001…) number on creation and may skip a discarded draft. **B)** Restart every year (INV-2026-0001). **C)** A series per branch                                                                                                                                                                                                                                                                                                                                                                   | **A**: the simplest gapless series; the law asks only for a sequence, and only for tax documents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Before Step 7               |
| Q26 | Which invoices                                                                     | **A)** Not registered for VAT: a plain "Invoice / فاتورة" and "Credit Note / إشعار دائن" (no VAT, never "tax"). Registered: always a full "Tax Invoice" and "Tax Credit Note" (no simplified ones), in AED. Documents in the business's own currency only. **B)** Also simplified tax invoices for consumers. **C)** Invoices only for VAT-registered businesses                                                                                                                                                                                                                                                                                                                                                                                                            | **A**: designers and home businesses invoice companies too (and from July 2027 those are e-invoices); e-invoicing doesn't take simplified ones, and a POS already prints receipts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Before Step 8               |
| Q27 | Statements                                                                         | **A)** Customer statements: each customer's page lists what was invoiced or delivered, paid and still owed, and prints a statement for a period (PDF), for every business with Customers on, with Release B. No supplier statements in M3. **B)** No statements in M3. **C)** Customer and supplier statements                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **A**: the factory's monthly accounts need it, and orders-only businesses get it too; suppliers send their own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Before Step 8               |

**Q10, proposed template defaults.**

- Profit, and every cost, fee and delivery cost, needs the costs switch (D-187, D-190). The exception is a delivery cost a member typed, which they see on their own records.
- Owner and Admin get everything. Document numbering settings are for the Owner and Admin only.
- Seeing every sale or order includes the sales totals.

| Template   | Customers                                      | Sales (Today's sales, One sale)   | Orders                        | Customer payments | Import, channels          | Reports               | Quotations                      | Invoices                         |
| ---------- | ---------------------------------------------- | --------------------------------- | ----------------------------- | ----------------- | ------------------------- | --------------------- | ------------------------------- | -------------------------------- |
| Manager    | see, add                                       | see all, enter, finalize, reverse | see all, enter, deliver, undo | see, record       | import; channels and fees | sales totals + profit | see, prepare, record the answer | see, prepare, issue, credit note |
| Accountant | see                                            | see all                           | see all                       | see, record       | —                         | sales totals + profit | see                             | see, prepare, issue, credit note |
| Sales      | see, add                                       | see all, enter, finalize          | see all, enter, deliver       | see, record       | —                         | sales totals only     | see, prepare, record the answer | see, prepare (not issue)         |
| Supervisor | see, add                                       | see all, enter, finalize          | see all, enter, deliver       | —                 | —                         | sales totals only     | —                               | —                                |
| Employee   | pick (name and the phone's last 4 digits), add | enter, finalize: own only         | enter, deliver: own only      | —                 | —                         | —                     | —                               | —                                |

The Employee's "own only" works like D-181 and D-214: they see and change only what they entered, and only while nobody else has changed it since. With Q12 A, any template can also be limited to some branches.

## Open items due by Phase 3, with proposed defaults (M3)

| Item (ROADMAP §Open, PRODUCT §6.12, D-191/D-202/D-203)               | Due                                        | Proposed default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-invoicing provider; re-verify the rules                            | Before Invoices                            | **Re-verified on 2026-10-04 (MoF and FTA texts):** <ul><li>MD 66/2026 replaces only MD 244 Art. 5(1)(a): businesses at AED 50M or more appoint an ASP by 30 Oct 2026 and go live on 1 Jan 2027 (the published decision is undated).</li><li>Everyone else keeps MD 244's dates: appoint by 31 Mar 2027, live on 1 Jul 2027. "No further extensions" comes from the MoF programme note of 30 Jun 2026.</li><li>B2C is out of scope (MD 244 Art. 5); B2B of businesses not registered for VAT is in (MD 243 Art. 3).</li><li>PINT-AE 1.0.4; 60 accredited ASPs.</li></ul> The provider gets its own milestone (Q24). Re-check at the start of Step 8                                                                                                                                            |
| PDF engine with correct Arabic; gapless numbering design             | Before Invoices                            | <ul><li>PDF: settled by the Step 1 bake-off (headless Chromium, Typst WebAssembly, react-pdf): Typst compiled to WebAssembly, D-224.</li><li>Numbering: a counter row locked FOR UPDATE last in the issuing transaction; a replay answered before a number is taken; the number text and its integer stored with UNIQUE; first proven on order numbers (Step 5)</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Make Round Amount with several VAT rates                             | Before Invoices                            | Q4: split by net over the rates; a leftover fils goes to a rounding difference of at most 0.02. The UI name is "Round the total / تقريب الإجمالي"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Arabic item descriptions on UAE tax invoices                         | Before Invoices                            | **Not required, per secondary sources** (KPMG on Tax Procedures ER 2023: English or Arabic; the FTA may ask for a translation). The tax agent confirms it at the Release B review. Keep one name (D-113). A line's description is copied and can be edited on the document (D-002), so Arabic can be typed there, and the labels are bilingual (Q23)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Plain invoices without VAT registration (§6.12 #4)                   | Before Invoices                            | Q26 A (as built: `invoices` has no `requiresCapabilities`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Negative stock                                                       | Phase 3 planning                           | Moves to Phase 4 planning, since M3 takes nothing out of stock (Q5). P-001's "allow" stays the proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Usage before the first stock count, in the ledger                    | Phase 3 planning                           | Q5 A: a snapshot on each sale line (`sale_line_materials`, at the 90-day average of the sale's day), with no ledger movement. Proposal for Phase 4: the first count starts each material's stock at that day's 90-day average, so product costs don't jump                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Money a supplier owes back                                           | Phase 3 planning (statements)              | Q18 A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Background jobs / outbox                                             | Before heavy cost-engine or report work    | Not needed in M3: <ul><li>files are parsed in the browser, rows arrive in chunks, and day totals are posted;</li><li>issued PDFs are rendered after the commit, and can be rendered again;</li><li>reports read on demand within tested budgets.</li></ul> Re-dated "before the e-invoicing connector" (status messages, retries) or emailing documents                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Running-cost rate: one month or several (D-202)                      | Phase 3 planning                           | Q6 A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A product sold without a list price, or at another price (D-202)     | Phase 3 planning                           | In real profit, it carries its share at the price it was sold for. Product costs keep the list price (`no_price` stays there only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rate × sales reveals the withheld month's costs (D-203)              | Phase 3 planning                           | Q11 A: profit reports show the total, accepted as a residue; the categories stay withheld                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Customers and Payments confirmed as Phase 3 modules                  | Phase 3 planning                           | Q2 A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Location scopes' screen "waits for a module used per branch" (D-191) | Phase 3 planning (implied)                 | Q12 A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A shop without a POS gets Orders, with a way out (§6.12 #3)          | Before the first real user                 | Kept; the way out is now real (Today's sales)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| «أمر عمل» for jobs (§6.12 #5)                                        | Before the first real user                 | Q19 A: unchanged for jobs (Phase 5); Orders are «الطلبات» everywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A bill pays only the running cost it names                           | Before the first real user                 | **Answered «1أ» (2026-10-01)**, built as D-216 and D-217. M3 extends its choice with "App fees of [channel]" and "Delivery already on my sales and orders" (Q8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Costs and supplier prices only together, also with real profit       | Before the first real user                 | Together (D-144, D-187): real profit, fees and delivery costs sit under the same switch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Issued invoices when a business is deleted                           | Before business deletion is built (not M3) | Issued invoices and credit notes are never hard-deleted for at least 5 years after their tax period (15 for real estate). The business is closed, not erased, and an archive export comes with the deletion screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The docs' inconsistencies                                            | Phase 3 planning                           | <ul><li>Bills above or below their regular amount: dropped, since bills replace it (D-202, D-216).</li><li>Charts: one drawn chart in M3; the library stays under "Later".</li><li>"View Selling Price": no key, since a price is not sensitive (D-187).</li><li>Progress invoices before Projects: Q22.</li><li>File types: no bucket change for imports (files are never uploaded); issued PDFs use the PDF type already allowed.</li><li>True Cost vs Phase 3: labour counts through Salaries in running costs, waste waits for Phase 4, and the words say so (Step 3).</li><li>PRODUCT §11 "a posted document is fixed with a reversing entry": for an issued invoice, that entry is a credit note (Step 8).</li><li>Real profit "by week" (owner spec 24): in M3, Monday weeks</li></ul> |

---
