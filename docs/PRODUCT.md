# BizCost: Product

Purpose: what BizCost is, who it is for, and the product rules every screen and feature must follow.
Last updated: 2026-09-24

> **Status:** nothing is built yet except the repo scaffold (Step 0a done). **DECIDED** = confirmed by the owner. **PLANNED** = intended but not built. Phases and step status: ROADMAP.md. Decision history: DECISIONS.md. Technical design: ARCHITECTURE.md. Tables and entities: DATA_MODEL.md.

## 1. Purpose & positioning

- Tagline: **"BizCost — Know Your Costs. Grow Your Business."**
- Second line: **"Keep the systems you already use. BizCost shows you what they don't: what your business really costs and earns."**
- It answers: (1) what does my product / order / job / project / business really cost? (2) what is my real profit? (3) where am I losing money? (4) what should I have used vs what did I actually use? (5) which products and projects are profitable?
- Core: **Cost Intelligence + Profit Intelligence + Usage/Waste Monitoring**. Other features exist only where they serve this core.

## 2. What BizCost is / is not

| BizCost is                                                                            | BizCost is not                                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A tool for true cost and real profit, for any small or medium business                | An accounting system. VAT Center = "VAT Preparation & Review", not tax filing |
| A layer on top of what the business already uses (POS, spreadsheets, WhatsApp orders) | A POS replacement                                                             |
| One adaptive app, with modules switched on or off per business                        | An ERP, or a full project-management app                                      |
| Bilingual EN/AR on web, iOS and Android                                               | Offline-first. Offline mode is NOT required (DECIDED)                         |

## 3. Target businesses & platforms

- **One app for all businesses (DECIDED):** home businesses, online sellers, F&B (coffee shops, bakeries, restaurants), retail, services, 3D printing and makers, workshops, manufacturing and factories, and project-based work (contracting, fit-out, decor, events).
- **First market:** UAE. Default currency AED, UAE VAT, Arabic + English. Many users have limited English.
- **Hierarchy:** User → Business → Locations → Team Members → Roles/Permissions → Modules → Data. One user can belong to several businesses. Each business has its own data, users, locations, settings, modules, permissions and financials. Details: DATA_MODEL.md.
- **Platforms (DECIDED):** desktop web (Windows/Mac browsers), mobile web, iPhone and Android apps, tablets.
  - Desktop is designed for desktop: sidebar, larger dashboards, tables, split views, multi-column forms, filters, detailed reports. It is never a stretched phone screen.
  - Mobile: fast actions, simple cards, easy entry, bottom navigation.
  - Tablet: hybrid of the two. In M1, iPad users use the web app (ARCHITECTURE.md §Platform roles & parity).

## 4. Core product rules (DECIDED)

1. **Single source of truth.** Each business fact is entered once and reused everywhere. There is one record each for a Customer, Supplier, Material, Employee, Product/Service and piece of Equipment, and no copies inside projects or documents. An edit made on a document line never changes the master record.
2. **Business type = recommended setup, NOT a limitation.** A home baker can later open a shop, hire staff, add equipment, register for VAT, add locations and start using inventory. It stays the same business with the same data, and no migration is needed (§5).
3. **Keep existing systems.** Never force a business to replace its POS. Sales can come from manual entry or an Excel/CSV import now, and from POS/API integrations later. All sources feed one sales model. Daily sales totals per product are enough for cost analysis.
4. **Simple language, no accounting jargon in the UI.** Backend and domain names can stay precise. Examples:

   | Avoid in UI                    | Use instead                                                  |
   | ------------------------------ | ------------------------------------------------------------ |
   | Overhead Allocation            | Running Costs                                                |
   | Fully loaded cost / COGS       | True Cost                                                    |
   | Net margin                     | Real Profit                                                  |
   | Bill of Materials              | Recipe / Materials / "What do you use to make this product?" |
   | Inventory shrinkage / variance | Unexplained Usage                                            |

5. **Neutral waste language.** Never accuse staff of theft. Usage that doesn't match is called "Unexplained Usage". Reasons the user can pick: waste/spillage, damaged/expired, staff use, free/complimentary, stock count correction, recipe needs adjustment, other, unknown. Impact is shown per week, per month and as an estimated yearly amount.
6. **Theoretical vs actual profit.** Theoretical profit uses the standard recipe cost. Actual profit comes after actual usage, waste, variance and real operating costs. Show both.
7. **True Cost** = material + labor + machine/equipment + packaging + delivery paid by the business + payment/selling fees + direct expenses + allocated running costs + waste/usage variance. **Real Profit = Revenue − True Cost.** It can be shown by product, order, job, project, day, week, month, location or business.
8. **Enter materials the way you buy them.** Example: 1 carton = 12 bottles, 1 bottle = 1 L, the carton costs AED 72, so the cost is AED 0.006/ml and a 200 ml recipe line costs AED 1.20. Material cost always comes from purchases (weighted average), never from a price typed into a recipe. There is **one weighted-average cost per business**, not per location (DECIDED). Rules: DATA_MODEL.md §6.
9. **Delivery is per transaction**, not an onboarding setting. On each sale or order: does it need delivery? If yes, record the area, the actual delivery cost and the amount charged. BizCost then shows who paid for delivery and the delivery margin.
10. **Purchase Orders are optional.** A purchase can be direct, verbal, or made with a PO.
11. **Discounts come before VAT** on every document line. Optional "Make Round Amount": the user types the final amount they want, and the system works out the adjustment before VAT.
12. **VAT is kept separate from profit.** It never inflates revenue or cost.
13. **Expenses:** the document type (Tax Invoice / Non-Tax Invoice / No Invoice) is independent of the payment method (cash, card, bank transfer, cheque, other). Approval before finalizing is optional.
14. **AI suggestions need confirmation** (future, Phase 6). AI only creates drafts, with confidence scores and duplicate detection. A person confirms before anything is posted.
15. **Never build around one industry.** Navigation, dashboards and wording adapt to the business through its setup (§5).

## 5. Adaptive product model (DECIDED, owner emphasis)

Goal: every business sees **only what it uses**, from a solo home business up to a workshop with many jobs. Adaptation works on two layers.

| Layer            | What it controls                                                                                                           | Examples                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Modules**      | Whole sections on or off: navigation, dashboard cards, "+" actions                                                         | Orders, Inventory, Projects, Payroll                                                                                                 |
| **Capabilities** | Business-level flags, derived from Smart Setup answers, that hide fields, sections, pickers and options **inside** screens | `works_alone` / `has_team`, single / multi location, `vat_registered`, `keeps_stock`, `uses_machines`, `sells_via_pos`, Jobs & Tasks |

What a capability hides when it is off (names are indicative until built):

- Solo business: no team, roles or permissions screens, and no "assigned to" fields.
- Single location: no location picker anywhere.
- Not VAT registered: no VAT fields.
- No stock: no stock quantities.
- No machines: no machine-hour fields.
- Sales through a POS: import sales instead of entering Orders (Orders is meant for businesses without a POS).
- **Jobs & Tasks** (for workshops with many jobs): cost and profit per job, covering materials, labor time and machine time. It is not a full project-management app.

Example: the same product, two very different setups.

|                       | Solo home baker                                                                    | Multi-task workshop                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Setup answers         | Food, home, alone, WhatsApp orders, not VAT registered, no machines                | Makes products/jobs, workshop, team, jobs, VAT registered, keeps stock, machines                    |
| Modules on            | Dashboard, Products, Ingredients, Purchases, Expenses, Running Costs, Orders       | The baker's modules + Inventory, Employees, Attendance, Equipment, Quotations, Invoices, VAT Center |
| Capabilities          | `works_alone`, single location, no VAT, no stock, no machines                      | `has_team`, `vat_registered`, `keeps_stock`, `uses_machines`, Jobs & Tasks                          |
| Hidden inside screens | Roles, "assigned to", location picker, VAT fields, stock quantities, machine hours | Only the options the workshop's own setup excludes                                                  |
| Labor cost from       | The owner's own time, per hour                                                     | Employees, attendance, labor time per job                                                           |
| Wording               | "Recipe", "Ingredients"                                                            | "Materials / Product Cost", "Jobs"                                                                  |

Rules:

- **Growth path with no migration.** When the business grows, the user switches capabilities or modules on in **Settings → Customize BizCost**. Existing records keep working. For example, a default location is created at setup, so multi-location only adds more locations.
- **No option the user doesn't use.** Every field, section, picker, menu item and "+" action is tied to a module or capability. If the business doesn't use it, it isn't shown.
- **Only released modules are ever shown. No placeholder screens.** Each module is marked `released` or `planned`. Navigation, tabs and "+" show only modules that are both released and enabled. Smart Setup can enable a planned module, but it stays hidden until it is released. There are no "coming soon" pages. In M1 only Dashboard and Settings are released.
- **Disabling a module hides it and never deletes its data.** Customize BizCost warns about modules that depend on it.
- **Wording adapts to the business type.** Terminology profiles: general, food, maker, workshop, factory, projects. The costing structure underneath is the same. How translation files handle this: ARCHITECTURE.md §i18n & RTL.

## 6. Smart Setup (principles DECIDED; build PLANNED for M1)

- Short adaptive onboarding: roughly **7–10 questions** shown per business (from the pool below). Skip logic removes questions that don't apply (only services → no materials/stock questions; no materials → no stock question; works alone → no team questions). Many questions allow more than one answer.
- **Bilingual.** Owner's example: "What do you do? / شو طبيعة شغلك؟".
- Flow: answers (saved with a version) → recommendation → **review screen that explains each recommended module in plain words** → the user confirms or edits → modules enabled, capabilities set, terminology profile chosen, default location and roles created → **"Your BizCost is ready"**.
- Everything can be changed later in Settings → Customize BizCost.

| #   | Question                                   | Answers                                                                                                   | Influences                                                                                                            |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | What do you do? (multi)                    | Sell products / make products / food & drinks / services / projects / other                               | Terminology profile; Products & Services; Materials + recipes; Projects or Jobs & Tasks                               |
| 2   | Where do you work?                         | Home / shop / office / workshop-factory / customer locations / multiple locations                         | single vs multi location → Locations/Branches; Running Costs suggestions; home → owner-time labor                     |
| 3   | Do you work alone or with a team?          | Alone / team                                                                                              | `works_alone` vs `has_team` → team, roles, Employees, Attendance, Payroll                                             |
| 4   | Do you sell products, services or both?    | Products / services / both                                                                                | Item types in Products & Services                                                                                     |
| 5   | Do you use materials or ingredients?       | Yes / no                                                                                                  | Materials, Suppliers, Purchases, product cost structure                                                               |
| 6   | Do you keep stock? (only if Q5 = yes)      | Yes / no                                                                                                  | `keeps_stock` → Inventory/Stock, Usage & Waste Monitor                                                                |
| 7   | Do you use machines or equipment?          | Yes / no                                                                                                  | `uses_machines` → Equipment/Machines, machine-hour fields                                                             |
| 8   | How do customers buy? (multi)              | Direct orders / shop / online / WhatsApp-social / jobs / projects                                         | Orders, Jobs & Tasks, Projects, Quotations                                                                            |
| 9   | How do you track sales now?                | No system / existing POS / orders-social / jobs-projects                                                  | `sells_via_pos` → Sales Data import; otherwise Orders                                                                 |
| 10  | Do you have regular expenses?              | Yes / no                                                                                                  | Running Costs, Expenses                                                                                               |
| 11  | Are you VAT registered?                    | Yes / no / not sure                                                                                       | `vat_registered` → VAT fields, TRN, VAT Center, tax invoices. No / not sure → VAT hidden until switched on (proposed) |
| 12  | What should BizCost help you with? (multi) | Real profit, product cost, expenses, sales/orders, employees, stock, projects, waste, quotations/invoices | Which optional modules are recommended; dashboard card priority                                                       |

## 7. Module catalog

Nothing is released yet. The Phase column follows ROADMAP.md, which is authoritative ("tentative" = not in the owner's roadmap yet). How a module is declared: ARCHITECTURE.md §Modules.

| Module                             | Kind       | What it does                                                                             | Phase             |
| ---------------------------------- | ---------- | ---------------------------------------------------------------------------------------- | ----------------- |
| Dashboard                          | Core       | Decision dashboard (§9). In M1 it only shows the setup checklist                         | 1 → 3             |
| Settings / Customize BizCost       | Core       | Business profile, TRN, locations, team, roles, modules, language                         | 1                 |
| Products & Services                | Core       | Master list: unit, default price, VAT setting, active. Holds the cost structure (recipe) | 2                 |
| Materials / Ingredients            | Core       | Shared master records, bought in any unit and converted to a base unit                   | 2                 |
| Suppliers                          | Core       | One record, reused by purchases, expenses and materials                                  | 2                 |
| Purchases                          | Core       | Supplier, items, units, VAT, payment, attachments. PO optional                           | 2                 |
| Expenses                           | Core       | Document type separate from payment method; optional approval                            | 2                 |
| Running Costs                      | Core       | "What do you pay to run your business?" Allocated to products, jobs and projects         | 2                 |
| Files / Attachments                | Core       | Receipts and documents attached to records                                               | 2                 |
| Cost Engine                        | Core       | Unit costs, weighted average, True Cost (basic in 2, full in 3)                          | 2 → 3             |
| Customers                          | Core       | One customer across orders, quotations, invoices and payments                            | 3 (tentative)     |
| Sales Data                         | Core       | Manual entry and Excel/CSV import (POS/API in Phase 6)                                   | 3                 |
| Payments                           | Core       | Payments on sales, orders and invoices                                                   | 3 (tentative)     |
| Reports                            | Core       | Real profit reports (advanced analytics in Phase 6)                                      | 3 → 6             |
| Orders                             | Optional   | For businesses without a POS: items, discount, delivery, payment, status                 | 3                 |
| Quotations                         | Optional   | Revisions, approval, signed PDF, convert to an invoice                                   | 3                 |
| Invoices                           | Optional   | UAE tax invoices (§11)                                                                   | 3                 |
| Inventory / Stock                  | Optional   | Stock linked to materials, purchases, sales, recipes and counts                          | 4                 |
| Usage & Waste Monitor              | Optional   | Expected vs actual usage, unexplained cost, alerts beyond a tolerance you set            | 4                 |
| Employees                          | Optional   | One employee record for labor cost, payroll and projects                                 | 5                 |
| Attendance / Overtime              | Optional   | Hours that feed labor cost                                                               | 5                 |
| Payroll / Advances / Deductions    | Optional   | Pay runs and adjustments                                                                 | 5 (tentative)     |
| Equipment / Machines               | Optional   | Purchase cost, useful life, maintenance, power → machine cost per hour                   | 5                 |
| Vehicles                           | Optional   | Vehicle costs for projects and running costs                                             | 5                 |
| Projects                           | Optional   | Deeper workflow: variations, progress invoices, project profit                           | 5                 |
| Petty Cash / Employee Cash Custody | Optional   | Cash given to staff → receipts or returned cash → reconciled                             | 5                 |
| VAT Center                         | Optional   | VAT preparation and review, kept separate from profit                                    | 5                 |
| Locations / Branches               | Optional   | More than one location. In M1 it lives inside Settings, not as its own nav module        | 1 (in Settings)   |
| Jobs & Tasks                       | Capability | Cost and profit per job for workshops (§5)                                               | 5 (with Projects) |
| AI assistant                       | Future     | Invoice capture, suggestions, "Why did my profit drop?"                                  | 6                 |

## 8. Roles & permissions (principles)

- Every team member has their own login. Auth details: ARCHITECTURE.md §Auth.
- **Staff without email (DECIDED):** they sign in with a PIN on a shared branch device. From M1 the data model allows a member without a login account. The PIN sign-in screens come later.
- Role templates are copied into each business and can be edited. Starter set (DECIDED in M1 Step 2; keys in `packages/modules`):

  | Template   | Can do and see                                                                                                  |
  | ---------- | --------------------------------------------------------------------------------------------------------------- |
  | Owner      | Everything, including permissions added later; cannot be locked out. Only an owner can transfer ownership       |
  | Admin      | Every permission (not ownership transfer)                                                                       |
  | Manager    | Dashboard; view the business and the team; manage locations; see cost, profit/margin and supplier prices        |
  | Accountant | Dashboard; view the business; see cost, profit/margin, supplier prices and payroll (not employee personal data) |
  | Sales      | Dashboard only                                                                                                  |
  | Supervisor | Dashboard; view the team                                                                                        |
  | Employee   | Dashboard only (sees no sensitive field)                                                                        |

  Modules add their own permissions to the templates when they are released. Every member can open Settings for their own profile and language.

- Custom permissions, for example: View/Create/Edit Orders, View Customers, View Selling Price, View Product Cost, View Profit, Create/Approve Expenses, View Payroll, Manage Employees, Manage Projects.
- **Never assume every user can see cost or profit.** Sensitive fields (cost, profit/margin, supplier price, payroll, employee personal data) are removed on the server. The UI shows a lock, not a misleading zero. Users can't filter, sort or search by a field they can't see. Mechanism: ARCHITECTURE.md §Permissions, modules & capabilities.
- A business always has at least one active owner. Transferring ownership is an explicit action.
- **M1 UI:** role templates, assigning a role, editing a role's permissions. Per-member overrides and the sensitive-fields section come with the first module that has sensitive fields.
- For a solo business, all team and role screens are hidden (§5).

## 9. Dashboard philosophy

- A **Decision Dashboard**. It adapts to the business type, the enabled modules and the data that actually exists. There are no cards for data the business doesn't have.
- Card pool: sales, true cost, real profit, material / labor / running / waste cost, best products, low-margin products, cost increases, usage alerts, project profitability.

| Business        | Typical cards                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Coffee shop     | Sales, real profit, ingredient/labor/running cost, waste, stock, usage alerts, product profitability  |
| Home bakery     | Orders, sales, product profit, ingredients, packaging, delivery, owner labor, recent orders           |
| 3D printing     | Orders, sales, filament, machine cost, electricity, utilization, failed prints, product profitability |
| Project company | Project revenue/costs/profit, employees, purchases, expenses, vehicles, running costs, project alerts |

- Mobile navigation idea (not final): Home | Sales | + | Costs | More, with a "+" that depends on the business (home business: New Order, Expense, Customer, Product; project company: New Project, Expense, Purchase, Quotation, Employee). The "+" lists only modules that are released and enabled. **Mobile M1 = Home + More only.**

## 10. First-time experience

- **M1 (DECIDED):** Home/Dashboard shows a real setup checklist built from real data: complete the business profile, add a TRN, invite a member, add a location. An item appears only if it fits the business's capabilities (e.g. no "Invite member" for a solo business).
- **When costing modules ship (PLANNED, Phase 2–3):** a checklist titled "Let's calculate your first real profit": add what you sell → add what you use to make it → add purchase prices → add regular business costs → add or import sales → see My Real Profit.

## 11. Invoicing (UAE) (requirement DECIDED; build PLANNED)

- These are **real UAE tax invoices**: TRN, gapless sequential numbering, Arabic text.
- **UAE e-invoicing will become mandatory.** Critic research: pilot from July 2026. Businesses with revenue of AED 50M or more appoint an Accredited Service Provider (ASP) by 30 Oct 2026 and go live on 1 Jan 2027. All others appoint one by 31 Mar 2027 and go live on 1 Jul 2027. Format: Peppol PINT-AE. **Re-verify these dates before building Invoices.**
- BizCost will **not** become an ASP. It will integrate with an accredited provider. Which provider: ROADMAP.md §Open, with deadline.
- Quotations & Invoices are in Phase 3, together with Sales and Orders (moved up; the owner did not object, D-005).
- Document features: revisions, customer approval, signed PDF upload, quotation → invoice, copy an invoice → quotation, document history, partial/progress invoices, variations, attachments (including per line). Products & Services autocomplete on lines.
- Line fields: description, qty, unit, unit price, subtotal, discount (% or fixed, before VAT), VAT, total.
- A posted document is never edited. Mistakes are fixed with a reversing entry. Details: DATA_MODEL.md §1.6.

## 12. Reference test cases

The design must handle all four without hacks. Use them to test the setup recommendations, costing and dashboards.

| #   | Case                             | Must cover                                                                                                        |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Coffee shop with an existing POS | Imported sales, products + recipes, bulk purchases with unit conversion, employees, rent, stock, waste monitoring |
| 2   | Home bakery                      | Orders, ingredients, packaging, delivery per order, owner time as labor                                           |
| 3   | 3D printing                      | Orders, filament, machine time, electricity, failed prints as waste                                               |
| 4   | Project company                  | Projects, employees, purchases, expenses, vehicles, running costs, project profitability                          |

## 13. UI language & terminology

- English + Arabic from day one, with LTR and RTL. Labels, validation and system messages are all translated. English is kept simple.
- **Arabic tone (DECIDED, D-067):** simple, friendly Modern Standard Arabic (فصحى مبسطة). Short sentences, no accounting jargon, gender-neutral where possible ("أدخل" is fine as the usual imperative), and the terms in the table below (e.g. the brand line "اعرف تكلفتك الحقيقية. وطوّر أعمالك."). English is plain and short. Latin digits by default; Arabic-Indic digits are accepted when typing. TRNs, codes, emails and numbers display left-to-right. OPEN: the owner's Smart Setup example uses Gulf wording ("شو طبيعة شغلك؟"); confirm the wording of the Smart Setup questions before Step 5.
- **Default language (DECIDED, D-067):** a new visitor gets Arabic or English from the browser's language (Arabic when it is neither). The choice is remembered on the device; once signed in, the language saved in the account wins, and it is also the language of the emails we send. Implementation: ARCHITECTURE.md (i18n & RTL).

| English (UI)          | Arabic (UI)           | Meaning / note                                                 |
| --------------------- | --------------------- | -------------------------------------------------------------- |
| Running Costs         | المصاريف التشغيلية    | Rent, utilities, salaries, licenses… Not "Overhead Allocation" |
| Expenses              | المصروفات             | Individual expense entries                                     |
| True Cost             | التكلفة الحقيقية      | All cost components (§4.7)                                     |
| Real Profit           | الربح الحقيقي         | Revenue − True Cost                                            |
| Theoretical Profit    | الربح النظري          | Profit at the standard recipe cost                             |
| Actual Profit         | الربح الفعلي          | Profit after actual usage and waste                            |
| Expected Usage        | الاستهلاك المتوقع     | Sales/production × recipe quantities                           |
| Actual Usage          | الاستهلاك الفعلي      | Opening stock + purchases − closing stock                      |
| Unexplained Usage     | استهلاك غير مبرر      | Actual − expected. Never "theft"                               |
| Waste                 | الهدر                 | Usage the user explained as waste                              |
| Recipe                | وصفة                  | Food wording for the product cost structure                    |
| Materials             | المواد                | Food profile: Ingredients / المكونات                           |
| Products & Services   | المنتجات والخدمات     |                                                                |
| Purchases             | المشتريات             |                                                                |
| Suppliers             | الموردون              |                                                                |
| Customers             | العملاء               |                                                                |
| Sales                 | المبيعات              |                                                                |
| Orders                | الطلبات               |                                                                |
| Stock                 | المخزون               |                                                                |
| Quotation             | عرض سعر               |                                                                |
| Tax Invoice           | فاتورة ضريبية         |                                                                |
| Petty Cash            | العهدة النقدية        | Employee cash custody                                          |
| Machine Cost per Hour | تكلفة الآلة في الساعة |                                                                |
| Team Members          | أعضاء الفريق          | People who can sign in                                         |
| Location / Branch     | الفرع                 |                                                                |
| Smart Setup           | الإعداد الذكي         |                                                                |
| Customize BizCost     | تخصيص BizCost         | Settings screen for modules and capabilities                   |
| Your BizCost is ready | BizCost جاهز لك       | Final line of Smart Setup                                      |
