# BizCost: Product

Purpose: what BizCost is, who it is for, and the product rules every screen and feature must follow.
Last updated: 2026-09-26

> **Status:** M1 in progress: auth, account, businesses and Smart Setup, settings, and the app shell with the Dashboard checklist are built (Steps 1–3, 5–7); no data module yet. **DECIDED** = confirmed by the owner. **PLANNED** = intended but not built. Phases and step status: ROADMAP.md. Decision history: DECISIONS.md. Technical design: ARCHITECTURE.md. Tables and entities: DATA_MODEL.md.

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

## 6. Smart Setup (principles DECIDED; question set v1 BUILT in Step 5, wording awaits the owner's confirmation)

Goal: the fewest questions that give each business a BizCost that fits it, from a solo home business to a workshop with many jobs. `QUESTION_SET_VERSION = 1`. Everything below is data and pure functions in `packages/modules` (questions, `normalizeAnswers`, `recommend`, `applyAdjustments`), shared by the web client and the API.

- **Flow:** step 0 business name (required, not counted) → up to 10 questions, one per screen, in a fixed order; skip logic shows **5–10** of them → review ("Here's your BizCost") → confirm → "Your BizCost is ready" → `/b/[businessId]`. Everything stays changeable later in Settings → Customize BizCost.
- **Every optional section comes from a concrete answer.** There is no "goals" question and no guessed wish. The server recomputes `recommend()` from the answers and never trusts a client-computed result.
- **Language:** simple MSA (D-067), gender-neutral where possible: options are first person («أبيع»، «أصنع»), statements are noun phrases, reasons are imperatives; no masculine adjectives or participles («متأكدًا»). Terminology overlays of the recommended profile apply already in the review.
- **Changes from the earlier pool:** "products, services or both" merged into Q1; materials, stock and machines merged into one checklist (`work_setup`); "how do you track sales" became the POS question; "regular expenses?" dropped (every business needs Expenses and Running Costs for True Cost); "goals" dropped; new: `how_you_make`, `team_tracking`, `invoice_later`. Services-only businesses still see "materials or supplies" (salons, cleaners and repairers use them) but never the stock option.

### 6.1 Data shape

```ts
type Answers = {
  what_you_do?: (
    'sell_products' | 'make_products' | 'food_drinks' | 'services' | 'projects' | 'other'
  )[]
  how_you_make?: ('catalog' | 'custom_jobs' | 'batches')[]
  workplace?: 'home' | 'shop' | 'office' | 'workshop' | 'factory' | 'kitchen' | 'customer_sites'
  branches?: boolean
  team?: 'alone' | 'team'
  team_tracking?: ('hours' | 'salaries' | 'staff_cash' | 'cost_only')[]
  work_setup?: ('materials' | 'stock' | 'machines' | 'vehicles' | 'none')[]
  sales_channels?: ('walk_in' | 'messages' | 'online' | 'quotes' | 'invoice_later')[]
  pos?: boolean
  vat?: 'yes' | 'no' | 'not_sure'
}
interface SetupQuestion {
  id: keyof Answers
  type: 'single' | 'multi' | 'yes_no' // single = option id, multi = set of ids, yes_no = boolean
  options: readonly { id: string; exclusive?: true; showIf?: (a: Answers) => boolean }[]
  showIf?: (a: Answers) => boolean // absent = always shown
  dependsOn: readonly (keyof Answers)[] // for progress counting (6.3)
  hint?: (a: Answers) => I18nKey | undefined
}
```

i18n keys (namespace `setup`): `setup.q.<id>.title`, `.short` (side list on desktop), `.hint`; options `setup.q.<id>.opt.<optId>.label` and `.hint`. Helpers used below: `has(xs, v)` (false when `xs` is undefined), `SELLS_MAKES = [sell_products, make_products, food_drinks]`.

### 6.2 Questions

Step 0, business name: text, required, 1–100 characters after trimming. Stored in `businesses.legal_name` for now (the Step 6 business profile asks for the name on the trade licence with the TRN).

| Key         | EN                                                                                                         | AR                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| title       | What's your business called?                                                                               | ما اسم عملك؟                                                                                     |
| hint        | The name your customers know, like your shop or Instagram name, or your own name. You can change it later. | الاسم الذي يعرفك به عملاؤك، مثل اسم المحل أو حساب إنستغرام، أو اسمك الشخصي. يمكنك تغييره لاحقًا. |
| placeholder | e.g. Sara's Sweets                                                                                         | مثال: حلويات سارة                                                                                |
| required    | Enter your business name.                                                                                  | أدخل اسم عملك.                                                                                   |
| too long    | Use 100 characters or fewer.                                                                               | استخدم 100 حرف أو أقل.                                                                           |

Order, skip logic and question text (hint "Choose all that apply." / «اختر كل ما ينطبق.» on every multi question unless another hint is given):

| #   | id               | Type   | Shown when                                              | dependsOn     | Short (EN / AR)              | Title EN / AR                                                                 | Hint EN / AR                                                                                                                                                                                                                                                     |
| --- | ---------------- | ------ | ------------------------------------------------------- | ------------- | ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `what_you_do`    | multi  | always                                                  | —             | Your work / طبيعة العمل      | What does your business do? / ما طبيعة عملك؟                                  | Choose all that apply.                                                                                                                                                                                                                                           |
| 2   | `how_you_make`   | multi  | `has(what,'make_products') && !has(what,'food_drinks')` | `what_you_do` | How you make / طريقة التصنيع | How are your products made? / كيف تُصنع منتجاتك؟                              | Choose all that apply.                                                                                                                                                                                                                                           |
| 3   | `workplace`      | single | always                                                  | —             | Workplace / مكان العمل       | Where do you mainly work? / أين مكان عملك في الغالب؟                          | —                                                                                                                                                                                                                                                                |
| 4   | `branches`       | yes_no | `workplace !== undefined && workplace !== 'home'`       | `workplace`   | Branches / الفروع            | Does your business have more than one branch? / هل لعملك أكثر من فرع؟         | Count your own shops, offices, workshops or stores, not your customers' places. / احسب محلاتك أو مكاتبك أو ورشك أو مستودعاتك، وليس أماكن عملائك.                                                                                                                 |
| 5   | `team`           | single | always                                                  | —             | Team / الفريق                | Does anyone work with you? / هل يعمل معك أحد؟                                 | —                                                                                                                                                                                                                                                                |
| 6   | `team_tracking`  | multi  | `team === 'team'`                                       | `team`        | Your team / متابعة الفريق    | What do you want to track for your team? / ما الذي يهمك متابعته لفريقك؟       | Choose all that apply.                                                                                                                                                                                                                                           |
| 7   | `work_setup`     | multi  | always                                                  | —             | Your setup / تفاصيل العمل    | Which of these apply to your work? / ما الذي ينطبق على عملك؟                  | When the `materials` option is hidden (`.hint_included`): The materials you buy to make or sell are already covered, so they aren't listed here. Choose all that apply. / المواد التي تشتريها لتصنع أو تبيع مشمولة تلقائيًا، لذلك لا تظهر هنا. اختر كل ما ينطبق. |
| 8   | `sales_channels` | multi  | `!(what.length === 1 && what[0] === 'projects')`        | `what_you_do` | How you sell / طرق البيع     | How do customers order and pay? / كيف يطلب منك العملاء ويدفعون؟               | Choose all that apply.                                                                                                                                                                                                                                           |
| 9   | `pos`            | yes_no | `workplace === 'shop'`                                  | `workplace`   | Cashier (POS) / الكاشير      | Do you have a cashier system (POS)? / هل لديك نظام كاشير (POS)؟               | If you have one, keep using it. You'll be able to import its daily sales from a file. / إذا كان لديك نظام كاشير فاستمر في استخدامه، وسيمكنك استيراد مبيعاته اليومية من ملف.                                                                                      |
| 10  | `vat`            | single | always                                                  | —             | VAT / الضريبة                | Is your business registered for VAT? / هل عملك مسجّل في ضريبة القيمة المضافة؟ | Choose Yes only if it has a tax registration number (TRN). You can change this later. / اختر «نعم» فقط إذا كان لعملك رقم تسجيل ضريبي (TRN). يمكنك تغيير ذلك لاحقًا.                                                                                              |

Options (label · hint). `*` = exclusive: choosing it clears the others, choosing any other option clears it.

| Question         | Option           | Shown when                                 | EN                                                                                                                                          | AR                                                                                                              |
| ---------------- | ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `what_you_do`    | `sell_products`  | always                                     | I sell products I buy ready-made · Shop, grocery, online store, trading                                                                     | أبيع منتجات أشتريها جاهزة · محل، بقالة، متجر إلكتروني، تجارة                                                    |
|                  | `make_products`  | always                                     | I make products (not food) · Furniture, metal work, 3D printing, handmade items, factory goods                                              | أصنع منتجات (غير الطعام) · أثاث، حدادة، طباعة ثلاثية الأبعاد، مشغولات يدوية، منتجات مصانع                       |
|                  | `food_drinks`    | always                                     | I make food or drinks · Café, restaurant, bakery, cakes and sweets, home kitchen                                                            | أحضّر طعامًا أو مشروبات · مقهى، مطعم، مخبز، كيك وحلويات، مطبخ منزلي                                             |
|                  | `services`       | always                                     | I offer services · Design, marketing, cleaning, salon, repairs                                                                              | أقدّم خدمات · تصميم، تسويق، تنظيف، صالون، صيانة                                                                 |
|                  | `projects`       | always                                     | I do projects for clients · Big jobs in stages, with workers and materials: fit-out, contracting, events                                    | أنفّذ مشاريع للعملاء · أعمال كبيرة على مراحل بعمّال ومواد: تشطيب وديكور داخلي، مقاولات، فعاليات                 |
|                  | `other`          | always                                     | Something else                                                                                                                              | شيء آخر                                                                                                         |
| `how_you_make`   | `catalog`        | always                                     | The same items again and again · A set list of products or designs                                                                          | أصنع المنتجات نفسها باستمرار · قائمة ثابتة من المنتجات أو التصاميم                                              |
|                  | `custom_jobs`    | always                                     | Made to order for each customer · To the customer's size, drawing or file, e.g. furniture, steel gates, signs                               | حسب طلب كل عميل · بمقاسات العميل أو رسوماته أو ملفاته، مثل الأثاث والأبواب الحديدية واللوحات                    |
|                  | `batches`        | always                                     | In large quantities · A factory or production line                                                                                          | بكميات كبيرة · مصنع أو خط إنتاج                                                                                 |
| `workplace`      | `home`           | always                                     | From home                                                                                                                                   | من المنزل                                                                                                       |
|                  | `shop`           | always                                     | A shop, café, restaurant or showroom                                                                                                        | محل أو مقهى أو مطعم أو صالة عرض                                                                                 |
|                  | `office`         | always                                     | An office                                                                                                                                   | مكتب                                                                                                            |
|                  | `workshop`       | always                                     | A workshop                                                                                                                                  | ورشة                                                                                                            |
|                  | `factory`        | always                                     | A factory                                                                                                                                   | مصنع                                                                                                            |
|                  | `kitchen`        | `has(what,'food_drinks')`                  | A commercial kitchen · A central or cloud kitchen, not at home                                                                              | مطبخ تجاري · مطبخ مركزي أو سحابي، خارج المنزل                                                                   |
|                  | `customer_sites` | always                                     | At my customers' places · Their sites, homes or offices                                                                                     | في أماكن العملاء · مواقعهم أو منازلهم أو مكاتبهم                                                                |
| `branches`       | `true` / `false` | —                                          | Yes, more than one / No, just one                                                                                                           | نعم، أكثر من فرع / لا، فرع واحد                                                                                 |
| `team`           | `alone`          | always                                     | No, just me · Even if family helps now and then without pay, or a freelancer does a job for me                                              | لا، أنا فقط · حتى لو ساعدتني العائلة أحيانًا دون أجر، أو استعنت بمستقل لبعض الأعمال                             |
|                  | `team`           | always                                     | Yes, one person or more · Employees, workers, partners or paid family members                                                               | نعم، شخص أو أكثر · موظفون أو عمّال أو شركاء أو أفراد من العائلة بأجر                                            |
| `team_tracking`  | `hours`          | always                                     | Working hours and overtime · Also used to count labour in your costs                                                                        | ساعات العمل والعمل الإضافي · وتُستخدم أيضًا لحساب تكلفة العمالة                                                 |
|                  | `salaries`       | always                                     | Paying salaries, with advances and deductions                                                                                               | صرف الرواتب مع السُّلف والخصومات                                                                                |
|                  | `staff_cash`     | always                                     | Cash given to staff for purchases · Settled later with receipts                                                                             | العهدة النقدية للموظفين · مبالغ تُعطى للموظفين للشراء، ثم تُسوّى بالإيصالات                                     |
|                  | `cost_only`\*    | always                                     | Just what my team costs, for now                                                                                                            | معرفة تكلفة الفريق فقط، حاليًا                                                                                  |
| `work_setup`     | `materials`      | `what ∩ SELLS_MAKES = ∅` (else implied)    | I use materials or supplies · Paint, parts, salon products, building materials                                                              | أستخدم مواد أو مستلزمات · دهانات، قطع غيار، منتجات صالون، مواد بناء                                             |
|                  | `stock`          | `what` has an option other than `services` | I keep stock and count what's left · Raw materials or goods on shelves that get restocked. Skip it if you buy what you need for each order. | لدي مخزون وأتابع ما تبقى منه · مواد خام أو بضاعة على رفوف يُعاد ملؤها. لا تختره إذا كان الشراء لكل طلب على حدة. |
|                  | `machines`       | always                                     | I want to count machine time in my costs · 3D printers, CNC, laser cutters, saws, welding, production lines                                 | أريد احتساب وقت الآلات في التكلفة · طابعات ثلاثية الأبعاد، CNC، قص بالليزر، مناشير، لحام، خطوط إنتاج            |
|                  | `vehicles`       | always                                     | I have vehicles for the business · Cars, vans, motorbikes or a staff bus used mainly for work. Not a personal car.                          | لدي مركبات مخصصة للعمل · سيارات أو شاحنات أو دراجات نارية أو حافلة عمال، وليست سيارة شخصية.                     |
|                  | `none`\*         | always                                     | None of these                                                                                                                               | لا شيء مما سبق                                                                                                  |
| `sales_channels` | `walk_in`        | `workplace === 'shop'`                     | They buy in person at my shop                                                                                                               | يشترون مني مباشرة في المحل                                                                                      |
|                  | `messages`       | always                                     | They order by WhatsApp, Instagram or phone · Then I deliver or they pick it up                                                              | يطلبون عبر واتساب أو إنستغرام أو الهاتف · ثم أوصل الطلب أو يستلمونه                                             |
|                  | `online`         | always                                     | Through my website, marketplaces or delivery apps · Like Amazon, Noon, Talabat or Deliveroo                                                 | عبر موقعي أو المتاجر الإلكترونية أو تطبيقات التوصيل · مثل أمازون ونون وطلبات وديليفرو                           |
|                  | `quotes`         | always                                     | I send a written quote before I start · For bigger jobs, custom work or events                                                              | أرسل عرض سعر مكتوبًا قبل أن أبدأ · للأعمال الكبيرة أو حسب الطلب أو للفعاليات                                    |
|                  | `invoice_later`  | always                                     | I invoice them and they pay later · Companies, purchase orders (LPO), wholesale or monthly accounts                                         | أرسل لهم فاتورة ويدفعون لاحقًا · شركات، أوامر شراء (LPO)، بيع بالجملة، حسابات شهرية                             |
| `pos`            | `true` / `false` | —                                          | Yes / No                                                                                                                                    | نعم / لا                                                                                                        |
| `vat`            | `yes`            | always                                     | Yes, registered · It has a tax registration number (TRN)                                                                                    | نعم، مسجّل · لديه رقم تسجيل ضريبي (TRN)                                                                         |
|                  | `no`             | always                                     | No                                                                                                                                          | لا                                                                                                              |
|                  | `not_sure`       | always                                     | Not sure                                                                                                                                    | لا أعرف                                                                                                         |

Latin terms and codes inside Arabic text (CNC, POS, TRN, LPO) sit in a left-to-right isolate.

Wizard chrome:

| Key            | EN                                       | AR                                |
| -------------- | ---------------------------------------- | --------------------------------- |
| title          | Smart Setup                              | الإعداد الذكي                     |
| progress       | Question {n} of {m}                      | السؤال {n} من {m}                 |
| next / back    | Next / Back                              | التالي / رجوع                     |
| exit           | Exit setup                               | الخروج من الإعداد                 |
| single error   | Choose one.                              | اختر خيارًا واحدًا.               |
| multi error    | Choose at least one.                     | اختر خيارًا واحدًا على الأقل.     |
| exclusive (SR) | Choosing this clears your other choices. | اختيار هذا يلغي اختياراتك الأخرى. |
| side list      | Name / Review                            | الاسم / المراجعة                  |

Question counts: minimum 5 (projects only, at home, alone), maximum 10 (makes products in a shop, with a team). Examples: home baker 6, coffee shop 9, workshop 9 (6.11).

### 6.3 Answers, validation, progress and accessibility

- **Answer shape:** single = option id, yes_no = boolean, multi = array of ids treated as a set (order never matters).
- **`normalizeAnswers(a)`** (pure): walk the questions in order; drop answers to hidden questions and hidden options inside visible multi questions (a hidden single answer is dropped too, e.g. `kitchen` after food is unticked). A visible question without an answer, or with an empty multi answer after dropping, makes the set incomplete.
- **Client:** sessionStorage keeps the name, every answer (also answers that became hidden, so going back restores them), the client-generated `businessId` (UUIDv7, kept until the business is created so a retry is idempotent) and the review adjustments. Progress, review and submit always use `normalizeAnswers`. If a changed answer leaves a visible question unanswered, Confirm (and a stored review step after a reload) goes to the first such question; Next goes to one that comes before the current question (reopened from the side list), otherwise on to the next shown question in order, so every unanswered question is still reached and options a change made visible (e.g. "They buy in person at my shop") are seen. Changing any answer after the review resets the review adjustments.
- **Server:** strict. VALIDATION for an answer to a hidden question, a hidden option, a missing visible answer, an exclusive option combined with another, an unknown id, or a wrong `questionSetVersion`. Nothing is silently fixed.
- **Progress:** walk the questions in order; a question is **counted** when `showIf(A)` is true, or when some question in its `dependsOn` is counted and still unanswered (a hidden dependency counts as settled). `m` = counted questions; `n` = position of the current question among them. `m` only goes down as the user answers and settles once `workplace` and `team` are answered (the questions that drive skipping come first). Step 0 is never counted.
- **UX:** one question per screen on phones and tablets, with big tappable option cards (label + hint), Back/Next, no auto-advance. Desktop ≥1024px: two columns, a side list (Name, the counted questions by `.short`, Review; answered steps can be reopened) and the question card.
- **Accessibility:** single and yes_no = radiogroup; multi = group of checkboxes; an exclusive option says it clears the others; on every step change focus moves to the question heading; everything works with the keyboard.

### 6.4 `recommend(answers)`: derived values, business type, default location

Input: normalised, complete answers (A). Output (pure, deterministic, total):

```ts
interface Recommendation {
  businessType:
    'food' | 'factory' | 'workshop' | 'projects' | 'maker' | 'retail' | 'services' | 'other'
  terminologyProfile: 'general' | 'food' | 'maker' | 'workshop' | 'factory' | 'projects'
  capabilities: Record<StoredCapabilityKey, boolean>
  vatRegistered: boolean | null // null = "Not sure": stored as false, the review shows a note
  modules: { id: ModuleId; reason: I18nKey }[] // the ON set, MODULE_IDS order, closed under deps
  offNotes: { id: ModuleId; reason: I18nKey }[] // off modules with a specific note (review only)
  jobsReason: I18nKey | null // reason of the "cost of each job" row (review only)
  defaultLocationKind: 'home' | 'shop' | 'office' | 'workshop' | 'site'
  defaultLocationNameKey: I18nKey
}
```

Rows written from it: an optional module in `modules` gets `enabled = true`; a core module missing from `modules` gets `enabled = false`; no other rows (D-059). Dashboard and Settings are always in `modules` with reason `setup.reason.always` (not displayed).

```text
sellsOrMakes  = A.what ∩ SELLS_MAKES ≠ ∅
hasGoods      = A.what has an option other than services and projects      // gate for Orders
usesMaterials = sellsOrMakes || 'materials' ∈ A.work_setup || 'stock' ∈ A.work_setup
keepsStock    = 'stock' ∈ A.work_setup
usesMachines  = 'machines' ∈ A.work_setup
hasTeam       = A.team === 'team'
multiLocation = A.branches === true
sellsViaPos   = A.pos === true
customOnly    = A.how_you_make is exactly [custom_jobs]
jobsAndTasks  = 'custom_jobs' ∈ A.how_you_make
                || ('services' ∈ A.what && 'food_drinks' ∉ A.what && 'projects' ∉ A.what
                    && 'quotes' ∈ A.sales_channels && (usesMaterials || usesMachines))
vatRegistered = { yes: true, no: false, not_sure: null }[A.vat]
```

The second `jobsAndTasks` branch covers service workshops (garage, phone repair, print shop). It never fires for a freelancer without materials or machines, for food (custom cakes are orders) or for project companies (Projects already costs each project).

Business type = **first match**; the terminology profile follows from it:

| #   | Condition                                                                                      | `businessType` | `terminologyProfile` |
| --- | ---------------------------------------------------------------------------------------------- | -------------- | -------------------- |
| 1   | `food_drinks ∈ what`                                                                           | `food`         | `food`               |
| 2   | `make_products ∈ what` and (`batches ∈ how` or `workplace = factory`)                          | `factory`      | `factory`            |
| 3   | `make_products ∈ what` and `custom_jobs ∈ how` and (`catalog ∉ how` or `workplace = workshop`) | `workshop`     | `workshop`           |
| 4   | `projects ∈ what`                                                                              | `projects`     | `projects`           |
| 5   | `make_products ∈ what`                                                                         | `maker`        | `maker`              |
| 6   | `jobsAndTasks`                                                                                 | `workshop`     | `workshop`           |
| 7   | `sell_products ∈ what`                                                                         | `retail`       | `general`            |
| 8   | `services ∈ what`                                                                              | `services`     | `general`            |
| 9   | otherwise                                                                                      | `other`        | `general`            |

Default location: one row, `is_default = true`, named in the user's language (then it is plain data). The name uses the final `multi_location` after review adjustments. Keys `setup.location.<workplace>` and `setup.location.<workplace>_main`:

| `workplace`      | Kind       | One place (EN / AR)       | More than one branch (EN / AR)  |
| ---------------- | ---------- | ------------------------- | ------------------------------- |
| `home`           | `home`     | Home / المنزل             | Main branch / الفرع الرئيسي     |
| `shop`           | `shop`     | Shop / المحل              | Main shop / المحل الرئيسي       |
| `office`         | `office`   | Office / المكتب           | Head office / المكتب الرئيسي    |
| `workshop`       | `workshop` | Workshop / الورشة         | Main workshop / الورشة الرئيسية |
| `factory`        | `workshop` | Factory / المصنع          | Main factory / المصنع الرئيسي   |
| `kitchen`        | `workshop` | Kitchen / المطبخ          | Main kitchen / المطبخ الرئيسي   |
| `customer_sites` | `site`     | Main base / المقر الرئيسي | Main base / المقر الرئيسي       |

### 6.5 Capabilities

Stored keys only in `capabilities`; VAT goes to `businesses.vat_registered` (D-052). A "Not sure" answer is not stored separately: `setup_answers` keeps it for a later reminder.

| Capability       | True when       |
| ---------------- | --------------- |
| `has_team`       | `hasTeam`       |
| `multi_location` | `multiLocation` |
| `keeps_stock`    | `keepsStock`    |
| `uses_machines`  | `usesMachines`  |
| `sells_via_pos`  | `sellsViaPos`   |
| `jobs_and_tasks` | `jobsAndTasks`  |

### 6.6 Modules

Core modules are on unless switched off; `recommend()` switches off only `materials`, `purchases`, `customers` and `payments`. Optional modules are on only when their rule matches. Reason keys are `setup.reason.<module>.<variant>`; the **first** matching variant wins.

**Core modules**

| Module          | On when                                             | Variant · when                                  | EN                                                                                          | AR                                                                                      |
| --------------- | --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `products`      | always                                              | `projects` · `projects ∈ what`, `!sellsOrMakes` | List the services and work items you put in your quotes, and what each really costs.        | أضف الخدمات وبنود العمل التي تضعها في عروض أسعارك، واعرف تكلفتها الحقيقية.              |
|                 |                                                     | `services` · `services ∈ what`, `!sellsOrMakes` | List the services you offer and what each one really costs.                                 | أضف الخدمات التي تقدمها، واعرف التكلفة الحقيقية لكل منها.                               |
|                 |                                                     | `custom` · `customOnly`                         | Save what you price often, with its usual unit, to price new orders faster.                 | احفظ ما تسعّره كثيرًا بوحدته المعتادة (بالمتر أو بالقطعة)، لتسعّر الطلبات الجديدة أسرع. |
|                 |                                                     | `default`                                       | List what you sell and see what each one really costs.                                      | أضف ما تبيعه، واعرف تكلفته الحقيقية.                                                    |
| `materials`     | `usesMaterials`                                     | `food` · `food_drinks ∈ what`                   | Track your ingredients and packaging, and what they cost.                                   | تابع المكونات ومواد التغليف وتكلفتها.                                                   |
|                 |                                                     | `make` · `make_products ∈ what`                 | Track the materials that go into your products, and what they cost.                         | تابع المواد التي تدخل في منتجاتك وتكلفتها.                                              |
|                 |                                                     | `resell` · `sell_products ∈ what`               | The goods you sell cost what you pay to buy them.                                           | تكلفة البضاعة التي تبيعها هي ما تدفعه لشرائها.                                          |
|                 |                                                     | `uses`                                          | Count the materials and supplies you use in your costs.                                     | احسب المواد والمستلزمات ضمن تكاليفك.                                                    |
| `suppliers`     | always                                              | `no_purchases` · `!usesMaterials`               | Save who you pay once, like software, printing or freelancers, and reuse them in expenses.  | احفظ من تدفع لهم مرة واحدة، مثل البرامج والطباعة والمستقلين، واستخدمهم في المصروفات.    |
|                 |                                                     | `projects` · `projects ∈ what`                  | Save each supplier and subcontractor once, and reuse them in purchases and expenses.        | احفظ كل مورد ومقاول باطن مرة واحدة، واستخدمه في المشتريات والمصروفات.                   |
|                 |                                                     | `default`                                       | Save the shops and suppliers you buy from once, and reuse them.                             | احفظ بيانات المحلات والموردين مرة واحدة، واستخدمها في المشتريات والمصروفات.             |
| `purchases`     | `usesMaterials`                                     | `default`                                       | What you pay when you buy sets your real costs.                                             | ما تدفعه عند الشراء هو ما يحدد تكلفتك الحقيقية.                                         |
| `expenses`      | always                                              | `default`                                       | Record every amount spent on the business, with or without a receipt.                       | سجّل كل مبلغ يُصرف على العمل، مع إيصال أو بدونه.                                        |
| `running_costs` | always                                              | `home` · `workplace = home`                     | Count what working from home costs, like electricity, gas, internet and subscriptions.      | احسب ما يكلّفه العمل من المنزل، مثل الكهرباء والغاز والإنترنت والاشتراكات.              |
|                 |                                                     | `default`                                       | Count what you pay regularly to run your business, like rent, electricity and your licence. | احسب ما تدفعه بانتظام لتشغيل عملك، مثل الإيجار والكهرباء والرخصة التجارية.              |
| `files`         | always                                              | `default`                                       | Keep receipts and documents with your records.                                              | احفظ الإيصالات والمستندات مع سجلاتك.                                                    |
| `cost_engine`   | always                                              | `jobs` · `jobsAndTasks`                         | See the true cost and profit of each job.                                                   | اعرف التكلفة الحقيقية والربح لكل أمر عمل.                                               |
|                 |                                                     | `solo` · `!hasTeam`                             | See the true cost of your work, including your own time.                                    | اعرف التكلفة الحقيقية لعملك، بما فيها وقتك.                                             |
|                 |                                                     | `default`                                       | See the true cost of everything you sell or do.                                             | اعرف التكلفة الحقيقية لكل ما تبيعه أو تقدّمه.                                           |
| `customers`     | `orders`, `quotations`, `invoices` or `projects` on | `default`                                       | Save each customer once and use them everywhere.                                            | احفظ بيانات كل عميل مرة واحدة، واستخدمها في كل مكان.                                    |
| `sales`         | always                                              | `pos_apps` · `sellsViaPos`, `online ∈ channels` | Import sales from your POS and delivery apps, with their fees, to see your real profit.     | استورد مبيعاتك من نظام الكاشير وتطبيقات التوصيل، مع عمولاتها، لتعرف ربحك الحقيقي.       |
|                 |                                                     | `pos` · `sellsViaPos`                           | Import your POS sales to see your real profit.                                              | استورد مبيعات نظام الكاشير لتعرف ربحك الحقيقي.                                          |
|                 |                                                     | `apps` · `online ∈ channels`                    | Bring in sales from your online store or delivery apps, with their fees.                    | أضف مبيعات متجرك الإلكتروني أو تطبيقات التوصيل، مع عمولاتها.                            |
|                 |                                                     | `with_orders` · `orders` on                     | Add the sales you don't record as orders.                                                   | أضف المبيعات التي لا تسجّلها كطلبات.                                                    |
|                 |                                                     | `invoices` · `invoices` on                      | Add any sales that don't come from your invoices.                                           | أضف أي مبيعات لا تأتي من فواتيرك.                                                       |
|                 |                                                     | `default`                                       | Add your sales to see your real profit.                                                     | أضف مبيعاتك لتعرف ربحك الحقيقي.                                                         |
| `payments`      | same as `customers`                                 | `projects` · `projects` on                      | Track deposits, stage payments and what each client still owes.                             | تابع الدفعات المقدمة ودفعات المراحل وما بقي على كل عميل.                                |
|                 |                                                     | `deposits` · `custom_jobs ∈ how`                | Track deposits and what each customer still owes.                                           | تابع الدفعات المقدمة وما بقي على كل عميل.                                               |
|                 |                                                     | `orders` · `orders` on                          | Know who paid, who paid a deposit and who still owes.                                       | اعرف من دفع، ومن دفع عربونًا، ومن بقي عليه مبلغ.                                        |
|                 |                                                     | `default`                                       | Know who has paid and who still owes.                                                       | اعرف من دفع ومن بقي عليه مبلغ.                                                          |
| `reports`       | always                                              | `projects` · `projects` on                      | See your real profit by project, month and more.                                            | اعرف ربحك الحقيقي حسب المشروع والشهر وغير ذلك.                                          |
|                 |                                                     | `default`                                       | See your real profit by product, month and more.                                            | اعرف ربحك الحقيقي حسب المنتج والشهر وغير ذلك.                                           |

**Optional modules**

| Module        | On when                                                                                                   | Variant · when                               | EN                                                                                                      | AR                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `orders`      | `hasGoods` and `!sellsViaPos` and channels ∩ {`messages`, `invoice_later`, `walk_in`} ≠ ∅                 | `invoice_later` · `invoice_later ∈ ch`       | Follow each order until it's delivered and paid.                                                        | تابع كل طلب حتى يُسلَّم ويُدفع.                                                                           |
|               |                                                                                                           | `custom_jobs` · `customOnly`                 | Keep each customer's order in one place, from deposit to delivery.                                      | تابع طلب كل عميل في مكان واحد، من الدفعة المقدمة حتى التسليم.                                             |
|               |                                                                                                           | `messages` · `messages ∈ ch`                 | Keep WhatsApp, Instagram and phone orders in one place, with delivery and payment.                      | اجمع طلبات واتساب وإنستغرام والهاتف في مكان واحد، مع التوصيل والدفع.                                      |
|               |                                                                                                           | `shop_no_pos` (walk-in, no POS)              | There's no POS in your shop, so record each sale here. If adding daily totals is easier, turn this off. | لا يوجد نظام كاشير في محلك، فسجّل كل عملية بيع هنا. وإذا كان إدخال مجموع المبيعات اليومي أسهل لك، فأوقفه. |
| `quotations`  | `projects ∈ what` or `quotes ∈ ch`                                                                        | `projects` · `projects ∈ what`               | Give each project a written price before you start.                                                     | قدّم عرض سعر مكتوبًا لكل مشروع قبل البدء.                                                                 |
|               |                                                                                                           | `quotes`                                     | Prepare written quotes for your customers before you start.                                             | جهّز عروض أسعار مكتوبة لعملائك قبل البدء.                                                                 |
| `invoices`    | `quotations` on, or `projects` on, or `invoice_later ∈ ch`, or (`vatRegistered === true` and `orders` on) | `projects` · `projects` on                   | Send invoices, including stage invoices for each project.                                               | أصدر الفواتير، ومنها فواتير الدفعات حسب مراحل كل مشروع.                                                   |
|               |                                                                                                           | `vat` · `vatRegistered === true`             | Your business is registered for VAT, so send tax invoices to your customers.                            | عملك مسجّل في ضريبة القيمة المضافة، فأصدر فواتير ضريبية لعملائك.                                          |
|               |                                                                                                           | `quotes` · `quotations` on                   | Turn accepted quotes into invoices and get paid.                                                        | حوّل عروض الأسعار المقبولة إلى فواتير، واحصل على مستحقاتك.                                                |
|               |                                                                                                           | `default`                                    | Send invoices to your customers and follow what they owe.                                               | أرسل الفواتير إلى عملائك، وتابع ما بقي عليهم.                                                             |
| `inventory`   | `keepsStock`                                                                                              | `default`                                    | See how much is left in stock.                                                                          | اعرف الكمية المتبقية من مخزونك.                                                                           |
| `usage_waste` | `keepsStock`                                                                                              | `make` · make ∈ what, food ∉ what            | See how much material goes to offcuts, failed pieces and waste, and what it costs.                      | اعرف كم يذهب من المواد في القصاصات والقطع التالفة والهدر، وكم يكلّفك ذلك.                                 |
|               |                                                                                                           | `resell` · sell ∈ what, make and food ∉ what | See what you lose to expired or damaged goods, and gaps you can't explain.                              | اعرف ما تخسره بسبب انتهاء الصلاحية أو التلف أو النقص غير المبرر.                                          |
|               |                                                                                                           | `default`                                    | Compare expected usage from your sales with actual usage, and see where the difference goes.            | قارن الاستهلاك المتوقع من مبيعاتك بالاستهلاك الفعلي، واعرف أين يذهب الفرق.                                |
| `employees`   | `hasTeam`                                                                                                 | `default`                                    | Others work with you, so their cost is part of your true cost.                                          | يعمل معك آخرون، وتكلفتهم جزء من تكلفتك الحقيقية.                                                          |
| `attendance`  | `hours ∈ team_tracking`                                                                                   | `default`                                    | Track working hours and overtime.                                                                       | تابع ساعات العمل والعمل الإضافي.                                                                          |
| `payroll`     | `salaries ∈ team_tracking`                                                                                | `default`                                    | Handle salaries, advances and deductions.                                                               | نظّم الرواتب والسُّلف والخصومات.                                                                          |
| `equipment`   | `usesMachines`                                                                                            | `default`                                    | Count what each machine costs per hour, including power and upkeep.                                     | احسب تكلفة كل آلة في الساعة، مع الكهرباء والصيانة.                                                        |
| `vehicles`    | `vehicles ∈ work_setup`                                                                                   | `default`                                    | See what your vehicles cost, like fuel and upkeep.                                                      | اعرف تكلفة مركباتك، مثل الوقود والصيانة.                                                                  |
| `projects`    | `projects ∈ what`                                                                                         | `default`                                    | See each project's costs (materials, labour, extra work) and its profit.                                | اعرف تكاليف كل مشروع (المواد والعمالة والأعمال الإضافية) وربحه.                                           |
| `petty_cash`  | `staff_cash ∈ team_tracking`                                                                              | `default`                                    | Track cash given to staff until it's settled with receipts or returned.                                 | تابع العهدة النقدية حتى تُسوّى بالإيصالات أو تُعاد.                                                       |
| `vat_center`  | `vatRegistered === true`                                                                                  | `default`                                    | Prepare and check your VAT return, kept apart from your profit.                                         | جهّز إقرار ضريبة القيمة المضافة وراجعه، منفصلًا عن ربحك.                                                  |

**Off notes** (`offNotes`, keys `setup.note.<module>.<variant>`), shown on the row in "More sections you can add":

| Module     | When                                                              | EN                                                                                                           | AR                                                                                        |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `orders`   | `hasGoods`, `sellsViaPos`, `messages ∈ ch` (`outside_pos`)        | Turn this on if some orders don't go through your POS.                                                       | فعّله إذا كانت بعض الطلبات لا تمر عبر نظام الكاشير.                                       |
| `invoices` | `sellsViaPos`, `vatRegistered === true`, invoices off (`pos_off`) | Your POS prints your receipts. Turn this on if you also need to send tax invoices, for example to companies. | نظام الكاشير يطبع إيصالاتك. فعّله إذا احتجت أيضًا إلى إرسال فواتير ضريبية، مثلًا للشركات. |

Why: a POS already records walk-in and phone sales, so Orders would count them twice (§5); `online` alone never turns Orders on (the store or app records its sales, which come in through Sales). A shop without a POS gets Orders (the old §6 rule), with a way out to daily totals. Services and project businesses never get Orders: their work comes through Quotations, Invoices and Projects.

**Manifest changes this needs** (so the recommendation and every review change stay closed under deps): `materials.deps = [purchases]` (material cost comes only from purchases, §4.8); `orders.deps = [products, customers, payments]`; `quotations.deps = [products, customers]`; `invoices.deps = [products, customers, payments]`; `projects.deps = [customers, payments]`. `invoices` gets **no** `requiresCapabilities`: a business that is not VAT-registered still sends plain invoices (owner to confirm, 6.12).

**Cost of each job** (the `jobs_and_tasks` capability shown as a row, keys `setup.jobs.*`): "Cost and profit of each job" / «تكلفة وربح كل أمر عمل». `jobsReason`: `custom_jobs` when `custom_jobs ∈ how` — "Each job is made to the customer's request, so see what each one costs you and what you earn." / «كل أمر عمل يُنفَّذ حسب طلب العميل، فاعرف تكلفة كل أمر وربحه.»; `services` when `services ∈ what` — "Each job is different, so see what each one costs you and what you earn." / «كل أمر عمل مختلف، فاعرف تكلفته وربحه.»; otherwise null. Description when off: "See what each job costs you and what you earn from it." / «اعرف تكلفة كل أمر عمل وربحه.» The maker profile says "order" / «طلب» instead of "job" / «أمر عمل» in these texts, in `setup.reason.cost_engine.jobs` and in the jobs statement (6.8).

### 6.7 Review: "Here's your BizCost"

Layout (phones: one column with a sticky bottom bar; desktop: the same content in a wider card):

1. Title, subtitle and the release banner.
2. **Chosen for your business:** the "cost of each job" row when `jobs_and_tasks` is on (first), then the optional modules that are on.
3. **Basics for every business:** the core modules that are on, collapsed to a line of name chips with Show/Hide; expanded, each has its reason and switch.
4. **About your business:** capability statements, each a row with a fixed topic label, the current statement and a switch (`role="switch"`, named by the topic).
5. **More sections you can add** (collapsed): modules that are off and whose required capabilities are on (VAT only when on), except those that clearly do not fit: Projects is not offered to food businesses, to businesses that only resell (`what = [sell_products]`) or to someone working alone from home. Plus the jobs row when it is off and `how_you_make` was shown or `services ∈ what` (without food or projects). Each shows its off note or its description.
6. Buttons: "Set up my BizCost" (primary) and "Change my answers".

Every module row: name (with the profile overlay), reason, switch. Dashboard and Settings are never listed. Groups are recomputed when a capability changes; toggling a module switch keeps its row in place. Reasons and off notes follow the current switches, not only the answers (`setupTexts`): the rules of 6.6 read the answers with the capabilities, VAT and modules as switched, so no row contradicts a statement (VAT off → Invoices no longer says "registered for VAT"; POS off → Sales no longer says "from your POS"). A recommended module whose variants no longer fit (Orders' `shop_no_pos` once the POS is on) shows its description.

**Release status (G3):** while every listed item is planned (all of M1), one banner at the top and no per-row tags. Once released and planned items are mixed, planned rows get a "Soon" / «قريبًا» tag and the banner goes. This is a list item in the review, never a page or a nav item.

**Statements** (`setup.cap.<key>.topic|on|off`). Shown when the value is true or the question or option that sets it was shown; `has_team`, `uses_machines` and `vat_registered` always:

| Capability       | Shown when                       | Topic (EN / AR)           | On (EN / AR)                                                    | Off (EN / AR)                                                   |
| ---------------- | -------------------------------- | ------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `has_team`       | always                           | Team / الفريق             | Others work with you / يعمل معك آخرون                           | Just you, no team / أنت فقط، بدون فريق                          |
| `multi_location` | true or `branches` shown         | Branches / الفروع         | More than one branch / أكثر من فرع                              | One branch / فرع واحد                                           |
| `keeps_stock`    | true or the `stock` option shown | Stock / المخزون           | You keep stock and count it / لديك مخزون تتابعه                 | No stock to track / بدون متابعة مخزون                           |
| `uses_machines`  | always                           | Machine time / وقت الآلات | Machine time counts in your costs / وقت الآلات يُحسب في التكلفة | Machine time isn't counted / وقت الآلات لا يُحسب                |
| `sells_via_pos`  | true or `pos` shown              | Cashier (POS) / الكاشير   | Your sales come from your POS / مبيعاتك من نظام الكاشير         | No POS / بدون نظام كاشير                                        |
| `vat_registered` | always                           | VAT / الضريبة             | Registered for VAT / عملك مسجّل في ضريبة القيمة المضافة         | Not registered for VAT / عملك غير مسجّل في ضريبة القيمة المضافة |

**Adjustments** — one pure `applyAdjustments(rec, adj)` drives the live review and the server. `adj` lists the final state of each item the user changed: modules by id, capabilities by key (including `vat_registered` and `jobs_and_tasks`), each at most once.

1. **Capabilities first** (registry order). Turning one on also turns on its anchor modules (and their deps): `has_team` → Employees; `keeps_stock` → Stock and Usage & Waste; `uses_machines` → Equipment; `vat_registered` → VAT Center, plus Invoices if Orders is on; others none. It also turns back on the recommended modules that turning it off turns off (those whose other required capabilities are on), so switching a capability off and on again gives the recommendation back (e.g. Team: Employees, Attendance, Payroll and Petty Cash). Turning one off turns off every module that requires it and the modules that depend on those.
2. **Modules second** (`MODULE_IDS` order). On: its deps turn on, and so do the stored capabilities it requires. A module that requires `vat_registered` while VAT is off → VALIDATION (the switch is disabled with a note). Off: the modules that depend on it turn off. Dashboard, Settings or an unknown id → VALIDATION.
3. The result must meet invariants 1–3 (6.10). `vat_registered` changes only by its own explicit adjustment, never as a side effect: it is a legal fact, not a preference.

Side effects are shown under the row that caused them ("Also turned on:" / "Also turned off:" followed by name chips; `aria-live="polite"`).

Review copy (keys `setup.review.*`):

| Key                  | EN                                                                                                                         | AR                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| title                | Here's your BizCost                                                                                                        | إليك BizCost المناسب لعملك                                                                            |
| subtitle             | Built from your answers. Turn off anything you don't need.                                                                 | أعددناه من إجاباتك. أوقف أي شيء لا تحتاجه.                                                            |
| banner (all planned) | BizCost opens in stages. The sections below are saved with your setup, and each one will appear by itself when it's ready. | يُطلق BizCost على مراحل. الأقسام التالية محفوظة مع إعدادك، وسيظهر كل منها تلقائيًا عندما يصبح جاهزًا. |
| soon tag (mixed)     | Soon                                                                                                                       | قريبًا                                                                                                |
| group: chosen        | Chosen for your business                                                                                                   | اخترناها لعملك                                                                                        |
| group: basics        | Basics for every business · Show / Hide                                                                                    | أقسام أساسية لكل الأعمال · عرض / إخفاء                                                                |
| group: about         | About your business                                                                                                        | عن عملك                                                                                               |
| group: more          | More sections you can add                                                                                                  | أقسام أخرى يمكنك إضافتها                                                                              |
| also on / also off   | Also turned on: / Also turned off:                                                                                         | وتم تفعيل ما يلي أيضًا: / وتم إيقاف ما يلي أيضًا:                                                     |
| team note (team on)  | Your team sees only what you allow. Costs and profit stay hidden from them unless you give access.                         | يرى فريقك ما تسمح به فقط، وتبقى التكاليف والأرباح مخفية عنهم إلا إذا منحتهم الصلاحية.                 |
| VAT not-sure note    | You chose Not sure, so VAT options are off for now. Turn them on once you have a TRN.                                      | اخترت «لا أعرف»، لذلك لم نفعّل خيارات الضريبة الآن. فعّلها عندما يصبح لديك رقم تسجيل ضريبي.           |
| needs VAT            | Needs VAT registration. Turn on VAT under About your business first.                                                       | يتطلب التسجيل في ضريبة القيمة المضافة. فعّله أولًا من قسم «عن عملك».                                  |
| buttons              | Set up my BizCost · Setting up… · Change my answers                                                                        | جهّز BizCost لعملي · جارٍ التجهيز… · تعديل إجاباتي                                                    |

The VAT not-sure note shows while the answer was "Not sure" and VAT is still off.

### 6.8 Ready screen and business home

- Ready (keys `setup.ready.*`): title "Your BizCost is ready" / «BizCost جاهز لك»; body "{businessName} is set up. Each section will appear here as soon as it's ready." / «تم إعداد {businessName}. سيظهر كل قسم هنا فور جاهزيته.»; button "Let's go" / «لنبدأ» → `/b/[businessId]`.
- Business home summary ("About your business" on the Dashboard, Step 7; the welcome above it names the business and the member's role): the statements of 6.7 from the saved capabilities. Team and VAT always; branches, stock, machine time, POS and cost per job only when on (a home business is never asked about branches, so "One branch" would read oddly). Cost per job (`setup.cap.jobs_and_tasks.on`): "Cost and profit for each job" / «تكلفة وربح كل أمر عمل على حدة» (maker: "order" / «طلب»).

### 6.9 Module names, overlays and descriptions

Names `modules.<id>.name`; descriptions `modules.<id>.desc` for every module that can appear in "More sections you can add". Overlays replace whole strings for the recommended profile.

| Module          | EN                    | AR                        | Overlays                                                             | Description EN / AR                                                                                       |
| --------------- | --------------------- | ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `products`      | Products & Services   | المنتجات والخدمات         | projects: Services & work items / الخدمات وبنود العمل                | —                                                                                                         |
| `materials`     | Materials             | المواد                    | food: Ingredients / المكونات · factory: Raw materials / المواد الخام | Track what you buy to make or sell, and what it costs. / تابع ما تشتريه لتصنعه أو تبيعه، وتكلفته.         |
| `suppliers`     | Suppliers             | الموردون                  |                                                                      | —                                                                                                         |
| `purchases`     | Purchases             | المشتريات                 |                                                                      | Record what you buy, so your costs come from real prices. / سجّل مشترياتك، لتأتي تكاليفك من أسعار حقيقية. |
| `expenses`      | Expenses              | المصروفات                 |                                                                      | —                                                                                                         |
| `running_costs` | Running Costs         | المصاريف التشغيلية        |                                                                      | —                                                                                                         |
| `files`         | Files & receipts      | الملفات والإيصالات        |                                                                      | —                                                                                                         |
| `cost_engine`   | True Cost             | التكلفة الحقيقية          |                                                                      | —                                                                                                         |
| `customers`     | Customers             | العملاء                   |                                                                      | Save each customer once and use them everywhere. / احفظ بيانات كل عميل مرة واحدة، واستخدمها في كل مكان.   |
| `sales`         | Sales                 | المبيعات                  |                                                                      | —                                                                                                         |
| `payments`      | Payments              | المدفوعات                 |                                                                      | Know who has paid and who still owes. / اعرف من دفع ومن بقي عليه مبلغ.                                    |
| `reports`       | Reports               | التقارير                  |                                                                      | —                                                                                                         |
| `orders`        | Orders                | الطلبات                   |                                                                      | Record each customer order, with delivery and payment. / سجّل طلبات العملاء مع التوصيل والدفع.            |
| `quotations`    | Quotations            | عروض الأسعار              |                                                                      | Send written quotes before you start the work. / أرسل عروض أسعار مكتوبة قبل بدء العمل.                    |
| `invoices`      | Invoices              | الفواتير                  |                                                                      | Send invoices and follow what customers owe. / أرسل الفواتير، وتابع ما بقي على العملاء.                   |
| `inventory`     | Stock                 | المخزون                   |                                                                      | Know how much stock is left. / اعرف الكمية المتبقية من المخزون.                                           |
| `usage_waste`   | Usage & Waste         | الاستهلاك والهدر          |                                                                      | See what's lost to waste and usage you can't explain. / اعرف ما يضيع في الهدر والاستهلاك غير المبرر.      |
| `employees`     | Employees             | الموظفون                  |                                                                      | Count what your team costs. / احسب تكلفة فريقك.                                                           |
| `attendance`    | Attendance & overtime | الحضور والعمل الإضافي     |                                                                      | Track working hours and overtime. / تابع ساعات العمل والعمل الإضافي.                                      |
| `payroll`       | Payroll               | الرواتب                   |                                                                      | Handle salaries, advances and deductions. / نظّم الرواتب والسُّلف والخصومات.                              |
| `equipment`     | Equipment & machines  | المعدات والآلات           |                                                                      | Count what your machines cost per hour. / احسب تكلفة آلاتك في الساعة.                                     |
| `vehicles`      | Vehicles              | المركبات                  |                                                                      | See what your vehicles cost. / اعرف تكلفة مركباتك.                                                        |
| `projects`      | Projects              | المشاريع                  |                                                                      | See each project's costs and profit. / اعرف تكاليف كل مشروع وربحه.                                        |
| `petty_cash`    | Petty Cash            | العهدة النقدية            |                                                                      | Track cash given to staff until it's settled. / تابع العهدة النقدية حتى تُسوّى.                           |
| `vat_center`    | VAT Center            | مركز ضريبة القيمة المضافة |                                                                      | Prepare and check your VAT return. / جهّز إقرار ضريبة القيمة المضافة وراجعه.                              |

### 6.10 Invariants (unit + fast-check property tests over every valid answer walk generated from the question data)

1. Dashboard and Settings are always on.
2. The on set is closed under `deps`.
3. Every on module has its `requiresCapabilities`; `vat_registered` counts only when `vatRegistered === true`.
4. (recommend) `recommend()` switches off no core module outside {materials, purchases, customers, payments}.
5. (recommend) `materials` and `purchases` are on exactly when `usesMaterials`; `inventory` and `usage_waste` exactly when `keeps_stock`.
6. (recommend) `customers` and `payments` are on exactly when orders, quotations, invoices or projects is on.
7. (recommend) `sells_via_pos` or `!hasGoods` ⇒ Orders off. `food_drinks ∈ what` ⇒ `how_you_make` hidden and `jobs_and_tasks` false.
8. The terminology profile always matches the business type (6.4).
9. `capabilities` has exactly `STORED_CAPABILITY_KEYS`.
10. Every key used (questions, options, hints, reasons, notes, descriptions, statements, locations, overlays) exists in EN and AR.
11. 5 ≤ visible questions ≤ 10.
12. The same answers give the same output whatever the order inside multi answers; every valid walk gives an output.
13. `applyAdjustments` output meets 1–3, and `vat_registered` changes only by its own adjustment.
14. Progress: answering in order never raises `m`; at the last visible question `n = m =` the number of visible questions.

### 6.11 Persona expectations (G6 table test)

Question order: what, how, workplace, branches, team, team_tracking, work_setup, channels, pos, vat. Capabilities not listed are false. "Core off" lists only the core modules switched off.

| #   | Persona                             | Answers                                                                                                                                         | Qs  | Type / profile      | Capabilities on · VAT                                        | Optional modules on (reason when not default)                                                                                                                                 | Core off             | Other reasons                                                                                                          | Location                  |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Home baker, alone                   | [food_drinks] · home · alone · [none] · [messages] · no                                                                                         | 6   | food / food         | none · false                                                 | orders (`messages`)                                                                                                                                                           | none                 | materials `food`, running_costs `home`, cost_engine `solo`, sales `with_orders`, payments `orders`                     | Home / المنزل             |
| 2   | Coffee shop, POS + staff            | [food_drinks] · shop · no · team · [hours, salaries, staff_cash] · [stock] · [walk_in, online] · yes · yes                                      | 9   | food / food         | has_team, keeps_stock, sells_via_pos · true                  | inventory, usage_waste, employees, attendance, payroll, petty_cash, vat_center                                                                                                | customers, payments  | sales `pos_apps`; off note invoices `pos_off`                                                                          | Shop / المحل              |
| 3   | 3D printing maker (one helper)      | [make_products] · [catalog, custom_jobs] · home · team · [cost_only] · [stock, machines] · [messages, online] · no                              | 8   | maker / maker       | has_team, keeps_stock, uses_machines, jobs_and_tasks · false | orders (`messages`), inventory, usage_waste (`make`), employees, equipment                                                                                                    | none                 | cost_engine `jobs`, payments `deposits`, sales `apps`, jobs row `custom_jobs` ("order")                                | Home / المنزل             |
| 4   | Fit-out / decor project company     | [projects] · customer_sites · no · team · [hours, salaries, staff_cash] · [materials, vehicles] · yes                                           | 7   | projects / projects | has_team · true                                              | quotations (`projects`), invoices (`projects`), projects, employees, attendance, payroll, petty_cash, vehicles, vat_center                                                    | none                 | products `projects`, materials `uses`, suppliers `projects`, payments `projects`, sales `invoices`, reports `projects` | Main base / المقر الرئيسي |
| 5   | Freelance designer (services only)  | [services] · home · alone · [none] · [messages, quotes, invoice_later] · no                                                                     | 6   | services / general  | none · false                                                 | quotations (`quotes`), invoices (`quotes`)                                                                                                                                    | materials, purchases | products `services`, suppliers `no_purchases`, cost_engine `solo`, sales `invoices`; jobs row in More                  | Home / المنزل             |
| 6   | Retail shop with stock              | [sell_products] · shop · no · team · [salaries, staff_cash] · [stock, vehicles] · [walk_in, messages] · yes · yes                               | 9   | retail / general    | has_team, keeps_stock, sells_via_pos · true                  | inventory, usage_waste (`resell`), employees, payroll, petty_cash, vehicles, vat_center                                                                                       | customers, payments  | materials `resell`, sales `pos`; off notes orders `outside_pos`, invoices `pos_off`                                    | Shop / المحل              |
| 7   | Small factory (cleaning products)   | [make_products] · [batches] · factory · no · team · [hours, salaries] · [stock, machines, vehicles] · [messages, quotes, invoice_later] · yes   | 9   | factory / factory   | has_team, keeps_stock, uses_machines · true                  | orders (`invoice_later`), quotations (`quotes`), invoices (`vat`), inventory, usage_waste (`make`), employees, attendance, payroll, equipment, vehicles, vat_center           | none                 | materials `make` ("Raw materials"), sales `with_orders`, payments `orders`                                             | Factory / المصنع          |
| 8   | Workshop with many jobs (carpentry) | [make_products] · [custom_jobs] · workshop · no · team · [hours, salaries, staff_cash] · [stock, machines, vehicles] · [messages, quotes] · yes | 9   | workshop / workshop | has_team, keeps_stock, uses_machines, jobs_and_tasks · true  | orders (`custom_jobs`), quotations (`quotes`), invoices (`vat`), inventory, usage_waste (`make`), employees, attendance, payroll, petty_cash, equipment, vehicles, vat_center | none                 | products `custom`, cost_engine `jobs`, payments `deposits`, sales `with_orders`; jobs row first                        | Workshop / الورشة         |

Edge cases (also tested):

| Case                                     | Answers                                                                                                                                                       | Expect                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metal factory, custom + batches, 2 sites | [make_products] · [custom_jobs, batches] · factory · yes · team · [hours, salaries, staff_cash] · [stock, machines, vehicles] · [invoice_later, quotes] · yes | 9 Qs; factory; has_team, multi_location, keeps_stock, uses_machines, jobs_and_tasks; orders `invoice_later`; payments `deposits`; Main factory / المصنع الرئيسي |
| Project company that also designs        | [projects, services] · office · no · team · [hours] · [materials, vehicles] · [messages, quotes] · yes                                                        | 8 Qs; projects; jobs_and_tasks false; Orders off                                                                                                                |
| Coffee shop that also takes DMs          | persona 2 with [walk_in, online, messages]                                                                                                                    | Orders off, off note `outside_pos`                                                                                                                              |
| Garage (services workshop)               | [services] · workshop · no · team · [hours] · [materials, machines] · [quotes] · yes                                                                          | 8 Qs; workshop / workshop; jobs_and_tasks; Orders off; quotations, invoices `vat`, equipment; jobs row `services`                                               |
| Maximum questions                        | [make_products] · [catalog] · shop · yes · team · [cost_only] · [stock] · [walk_in, messages] · no · not_sure                                                 | 10 Qs; maker; multi_location; `vatRegistered` null (stored false, note shown); orders `messages`; Main shop / المحل الرئيسي                                     |
| Minimum questions                        | [projects] · home · alone · [none] · no                                                                                                                       | 5 Qs; projects; materials and purchases off; suppliers `no_purchases`; quotations, invoices, projects                                                           |

Example `setup_answers.answers` for persona 1: `{"what_you_do":["food_drinks"],"workplace":"home","team":"alone","work_setup":["none"],"sales_channels":["messages"],"vat":"no"}`.

Checks against §5 and §12: persona 1 gets the §5 baker set (Products, Ingredients, Purchases, Expenses, Running Costs, Orders) and "your own time" (§12 case 2); persona 8 is a superset of the §5 workshop set; persona 2 = §12 case 1 (imported sales, stock, waste, employees); persona 3 = case 3 (orders, filament stock, machine time, failed prints); persona 4 = case 4 (projects, employees, purchases, vehicles, running costs).

### 6.12 Open points

For the owner to confirm:

1. The Smart Setup wording is simple MSA («ما طبيعة عملك؟»), not Gulf dialect (closes the ROADMAP open item).
2. The VAT question gives no threshold (no "required above AED 375,000"): it only says to choose Yes with a TRN, to avoid sounding like tax advice.
3. A shop without a POS gets Orders, with a reason that offers daily totals instead.
4. Invoices also serve businesses that are not VAT-registered (plain invoices; tax invoices when registered). This changes §7 and §11.
5. «أمر عمل» for "job" in the workshop, factory and general profiles («طلب» for makers).
6. Food: "Ingredients / المكونات" leaves out cups and boxes (the reason mentions packaging); keep it, or use "Ingredients & supplies / المكونات والمستلزمات".

Parked for later phases: a retail wording profile ("Goods / البضاعة") together with how resellers avoid entering one item as both product and material (Phase 2); expected usage from production records for batch factories (Phase 4); whether Orders and jobs are one structure in the workshop profile (Phase 5, with "Projects vs Jobs & Tasks").

## 7. Module catalog

Only Dashboard and Settings are released (M1). The Phase column follows ROADMAP.md, which is authoritative ("tentative" = not in the owner's roadmap yet). How a module is declared: ARCHITECTURE.md §Modules.

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
- **As built (Step 7, D-090, D-093; final for M1):** "Finish setting up" lists only the steps the member can do, with "n of m done":
  - **Complete your business profile** (members who may edit the business profile): done with the business name in Arabic (or a name already written in Arabic) and a logo; the step says which is missing.
  - **Add your TRN** (the same members, only for a VAT-registered business): done once the TRN is saved.
  - **Invite your first team member** (members who may manage the team, only for a business with a team): done once someone else has joined or an invitation is waiting. Only for the member who started the business: whoever joined later joined a team that had already started.
  - **Add your second branch** (members who may manage branches, only for a business with branches): done with a second branch. Not for a member who joined after the second branch was added.
  - A step that is undone again (the others left, a branch was removed) shows again, open, to everyone who can do it.
  - Each open step opens its settings section. When all are done, a small "You're all set" takes the list's place; each member can hide it for that business (remembered in the browser). A member who can do none of the steps (e.g. an Employee) sees the welcome and "About your business" only. A member whose role does not include the Dashboard opens the business on their first section (Settings in M1).
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
