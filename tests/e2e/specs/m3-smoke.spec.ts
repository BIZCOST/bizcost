import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  auditScreen,
  BAKER_ANSWERS,
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  RAW_KEY,
  setLanguage,
  settle,
  signIn,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Smoke over every M3 screen and its key states (ROADMAP.md M3 Step 10 and the M3 definition of done:
// "every M3 screen works in AR and EN at 375, 768 and 1440 px"), as m2-smoke.spec.ts does for M2.
// Six businesses hold what each screen shows, entered through the API (the screens' own specs enter
// the same through the screens):
//   - a café with a team, two branches, VAT, a POS and Talabat: last month's sales at both branches
//     and on Talabat (its statement posted), today's sheets of the owner and an employee ("2
//     sheets"), a One sale with delivery and a discount, a draft, a reversed sale, an import posted and
//     one waiting for a name to be settled, a draft statement; real profit by product, channel, branch,
//     week and day; the Dashboard's cards; the employee's own screens;
//   - a home baker: customers, order #1001 waiting with its deposit, one delivered, paid and refunded,
//     one cancelled with money back; what customers owe and a customer's statement;
//   - a fit-out company with its TRN and letterhead: quotations (a draft, one sent, one accepted with
//     stages, one declined, one revised, one expired), invoices (a draft, one issued from a stage, part paid, with a credit note), the
//     customer's statement, Settings → Documents;
//   - a factory: a deposit on an order without its tax invoice, an invoice of a delivered order, an
//     accepted quotation, and the café's Employee in its team;
//   - a designer not registered for VAT: a sale "they'll pay later" invoiced, a plain credit note;
//   - a workshop with nothing entered yet: every M3 list empty.
// The states: Sales (by day, imports), Today's sales (its choices behind "Change", several days),
// One sale (empty, delivery), a sale (finalized, a sheet, a draft, reversed, imported; Reverse and
// Refund), imports (the file, the columns, names to settle, posted), Orders (list, editor, waiting,
// Deliver, a payment, delivered, Refund, cancelled, Cancel, edit), Customers (list, new, one),
// What customers owe and "Pay several at once", statements, Real profit, the Dashboard's cards,
// Quotations (list, editor, draft, sent, Mark accepted, Mark declined, Revise, Copy, declined,
// superseded by its revision, the revision, expired and the expired list, accepted, its invoice's
// stages, Make an order, edit), Undo delivery, the Employee's order editor with its customer picker,
// Invoices (list, deposits without a tax invoice, editor, draft, Issue, issued, a payment, the credit
// note sheet, the PDF, edit, plain), M3 states on released M2 screens (Product costs with the
// running-cost share, an expense marked as a channel's app fees, an overpaid purchase and its money
// back from the supplier), Settings (index, Sales channels and a channel's statements,
// adding a channel, Documents, a member's branches), "Add new" and the phone's "More".
//
// On each, in each language and at each width: <html lang dir> of the language, a visible h1, the
// page not wider than the screen and nothing drawn past its sides (a sheet's content included), no
// untranslated key or placeholder in the text, the title or the accessible names, no NaN or
// undefined, Arabic text in Arabic and none in English. Every problem of a run is reported at once
// (soft checks). With E2E_SHOTS_DIR set, each state leaves a screenshot there
// (`<locale>-<width>-<state>.png`).

test.describe.configure({ mode: 'serial' })

type Who = 'owner' | 'employee'

interface Context {
  page: Page
  width: number
  /** The English or the Arabic of a name, by the run's language. */
  L: (en: string, ar: string) => string
}

interface Screen {
  name: string
  who: Who
  path: () => string
  /** Only at these widths (default: all). */
  widths?: readonly number[]
  /** Opens the state (a sheet, a menu, a form filled in) once the page is ready. */
  open?: (context: Context) => Promise<void>
}

const LOCALES = ['en', 'ar'] as const
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const

/** A café with a team, a second branch, VAT and a POS: every capability that shows a field is on. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: true,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: true,
  vat: 'yes',
}

/** A fit-out / decor project company with a team and VAT (Quotations and Invoices on). */
const FITOUT_ANSWERS = {
  what_you_do: ['projects'],
  workplace: 'customer_sites',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['materials'],
  vat: 'yes',
}

/** A small factory with a team and VAT, invoicing companies on credit with their LPOs. */
const FACTORY_ANSWERS = {
  what_you_do: ['make_products'],
  how_you_make: ['batches'],
  workplace: 'factory',
  branches: false,
  team: 'team',
  team_tracking: ['hours', 'salaries'],
  work_setup: ['stock', 'machines'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'yes',
}

/** A designer alone, not registered for VAT, who invoices companies later. */
const DESIGNER_ANSWERS = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
}

const users: TestUser[] = []
const contexts: BrowserContext[] = []
const pages = {} as Record<Who, Page>
const seed = {
  /** The café's today (YYYY-MM-DD), in the business's time zone. */
  today: '',
  cafeId: '',
  bakerId: '',
  fitoutId: '',
  factoryId: '',
  designerId: '',
  emptyId: '',
  employeeMemberId: '',
  talabatId: '',
  oneSale: '',
  sheetSale: '',
  draftSale: '',
  reversedSale: '',
  importedSale: '',
  draftImport: '',
  postedImport: '',
  employeeSale: '',
  pendingOrder: '',
  deliveredOrder: '',
  cancelledOrder: '',
  bakerCustomer: '',
  fitCustomer: '',
  draftQuotation: '',
  sentQuotation: '',
  acceptedQuotation: '',
  draftInvoice: '',
  issuedInvoice: '',
  factoryInvoice: '',
  designerSale: '',
  designerInvoice: '',
  latte: '',
  overpaidPurchase: '',
  declinedQuotation: '',
  supersededQuotation: '',
  revisionQuotation: '',
  expiredQuotation: '',
  factoryQuotation: '',
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

async function openAs(browser: Browser, user: TestUser, displayName: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, locale: 'en-US', acceptDownloads: true })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  // Leaving a file read and not sent asks first (D-161): the import's columns are left on purpose.
  page.on('dialog', (dialog) => void dialog.accept())
  await signIn(page, user)
  await ok(callApi(page, 'account.updateProfile', { displayName }), 'updateProfile')
  return page
}

/** `day` moved by `days` (YYYY-MM-DD). */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The month (YYYY-MM) `months` before `day`'s. */
function monthsBefore(day: string, months = 1): string {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() - months)
  return date.toISOString().slice(0, 7)
}

/** The last day of `month` (YYYY-MM). */
function lastDayOf(month: string): string {
  return addDays(`${monthsBefore(`${month}-01`, -1)}-01`, -1)
}

/** A file's SHA-256 in hex (any text stands for a file's bytes). */
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

/** A CSV file to pick (UTF-8 with a byte-order mark, as spreadsheets save Arabic). */
function csv(name: string, lines: readonly string[]) {
  return {
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'),
  }
}

/** The procedures of one business, as the page's user. */
function api(page: Page, businessId: string) {
  return {
    call: <T = unknown>(path: string, input: unknown) =>
      ok(callApi<T>(page, path, input, { businessId }), path),
    query: <T = unknown>(path: string, input: unknown = {}) =>
      ok(callApi<T>(page, path, input, { businessId, query: true }), path),
  }
}

type Api = ReturnType<typeof api>

/** Invites `user` into the business with the role of `templateKey`; they accept it. */
async function joinTeam(owner: Api, member: Page, user: TestUser, templateKey: string) {
  const roles = await owner.query<{ id: string; templateKey: string | null }[]>('role.list')
  await owner.call('invitation.create', {
    id: randomUUID(),
    email: user.email,
    roleId: roles.find((role) => role.templateKey === templateKey)?.id,
    locale: 'en',
  })
  const { token } = await nextInvitation(user.email)
  await ok(callApi(member, 'invitation.accept', { token }), 'invitation.accept')
  const members = await owner.query<{ id: string; email: string | null }[]>('member.list')
  return members.find((member) => member.email === user.email)?.id ?? ''
}

async function channels(b: Api) {
  return (
    await b.query<{ data: { items: { id: string; kind: string; name: string }[] } }>(
      'channel.list',
      { status: 'active' },
    )
  ).data.items
}

/** A finalized purchase without an invoice, paid in cash. */
async function buy(b: Api, businessDate: string, lines: object[]) {
  const id = randomUUID()
  const draft = await b.call<{ data: { version: number } }>('purchase.create', {
    id,
    businessDate,
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    lines: lines.map((line) => ({ kind: 'material', id: randomUUID(), vatRate: '0', ...line })),
  })
  await b.call('purchase.post', { id, version: draft.data.version })
}

async function product(b: Api, name: string, price: string, extra: object = {}) {
  const id = randomUUID()
  await b.call('product.create', {
    id,
    name,
    type: 'product',
    unit: 'piece',
    defaultPrice: price,
    ...extra,
  })
  return id
}

interface Sale {
  id: string
  version: number
  lines: { id: string }[]
}

/** A sale (a draft, or finalized with `post`), as `b`'s user. */
async function sell(b: Api, input: object, post = true): Promise<Sale> {
  const draft = (await b.call<{ data: Sale }>('sale.create', { id: randomUUID(), ...input })).data
  if (!post) return draft
  return (await b.call<{ data: Sale }>('sale.post', { id: draft.id, version: draft.version })).data
}

const item = (productId: string, qty: string, unitPrice: string, extra: object = {}) => ({
  kind: 'item',
  id: randomUUID(),
  productId,
  qty,
  unitPrice,
  ...extra,
})

/** The fictional business's TRN and letterhead, as Settings → Business saves them. */
async function taxReady(b: Api, legalName: string) {
  const profile = await b.query<{ version: number }>('business.profile')
  await b.call('business.updateProfile', {
    version: profile.version,
    legalName,
    legalNameAr: null,
    vatRegistered: true,
    trn: '100345678900003',
    letterhead: {
      phone: '+971 4 555 0142',
      phone2: null,
      email: 'hello@smoke.example',
      addressLine: 'Warehouse 7, Al Quoz Industrial 3',
      city: 'Dubai',
      emirate: 'dubai',
      tradeLicenceNo: 'DED-884210',
      tradeLicenceAuthority: 'Dubai DET',
    },
  })
}

const typed = (description: string, qty: string, unitPrice: string, unit = 'piece') => ({
  id: randomUUID(),
  productId: null,
  description,
  qty,
  unit,
  unitPrice,
})

/** The café: last month's sales and statement, today's sheets, a One sale of each kind, imports. */
async function seedCafe(owner: Page, employee: Page, employeeUser: TestUser) {
  const cafeId = await createBusiness(owner, 'Smoke Café', CAFE_ANSWERS)
  const b = api(owner, cafeId)
  const { today } = await b.query<{ today: string }>('books.get')
  const last = monthsBefore(today)
  const before = monthsBefore(today, 2)
  const marina = randomUUID()
  await b.call('location.create', { id: marina, name: 'Marina branch' })
  const talabat = randomUUID()
  await b.call('channel.create', {
    id: talabat,
    name: 'Talabat',
    kind: 'delivery_app',
    feePercent: '20',
  })
  const shop = (await channels(b)).find((channel) => channel.kind === 'shop')!.id
  const employeeMemberId = await joinTeam(b, employee, employeeUser, 'employee')

  // The latte (beans and milk bought before last month), the croissant without its recipe.
  const milk = randomUUID()
  const beans = randomUUID()
  await b.call('material.create', { id: milk, name: 'Milk', unit: 'l', packs: [] })
  await b.call('material.create', { id: beans, name: 'Coffee beans', unit: 'kg', packs: [] })
  await buy(b, `${before}-01`, [
    { materialId: milk, qty: '500', unit: 'l', unitPrice: '6' },
    { materialId: beans, qty: '50', unit: 'kg', unitPrice: '65' },
  ])
  const latte = await product(b, 'Spanish Latte', '18')
  await b.call('recipe.save', {
    productId: latte,
    version: 0,
    lines: [
      { id: randomUUID(), materialId: beans, qty: '18', unit: 'g' },
      { id: randomUUID(), materialId: milk, qty: '200', unit: 'ml' },
    ],
  })
  const croissant = await product(b, 'Croissant', '9')
  const categories = await b.query<{ items: { id: string; name: string }[] }>('costCategory.list', {
    limit: 100,
  })
  await b.call('runningCost.create', {
    id: randomUUID(),
    name: 'Shop rent',
    categoryId: categories.items.find((category) => category.name === 'Rent')!.id,
    amount: '12000',
    frequency: 'monthly',
    startsOn: `${before}-01`,
  })

  // Sales: the first one the month before last; last month at both branches and on Talabat; its
  // statement posted, and a draft one for this month.
  await sell(b, {
    source: 'day_sheet',
    channelId: shop,
    businessDate: `${before}-10`,
    lines: [item(latte, '10', '18')],
  })
  await sell(b, {
    source: 'day_sheet',
    channelId: shop,
    businessDate: `${last}-05`,
    lines: [item(latte, '1000', '18'), item(croissant, '300', '9')],
  })
  await sell(b, {
    source: 'day_sheet',
    channelId: shop,
    locationId: marina,
    businessDate: `${last}-12`,
    lines: [item(latte, '400', '18')],
  })
  await sell(b, {
    source: 'single',
    channelId: talabat,
    locationId: marina,
    businessDate: `${last}-20`,
    lines: [item(latte, '200', '18')],
  })
  const statement = (
    await b.call<{ data: { id: string; version: number } }>('channelStatement.create', {
      id: randomUUID(),
      channelId: talabat,
      periodFrom: `${last}-01`,
      periodTo: lastDayOf(last),
      sales: '3600',
      commission: '648',
      paymentFees: '36',
    })
  ).data
  await b.call('channelStatement.post', { id: statement.id, version: statement.version })
  await b.call('channelStatement.create', {
    id: randomUUID(),
    channelId: talabat,
    periodFrom: `${today.slice(0, 7)}-01`,
    periodTo: today,
    commission: '12',
  })

  // Today: the owner's sheet and the employee's (the owner sees "2 sheets"), a One sale with delivery
  // and a discount, a draft, a reversed sale.
  const sheetSale = (
    await sell(b, {
      source: 'day_sheet',
      channelId: shop,
      businessDate: today,
      lines: [item(latte, '40', '18'), item(croissant, '25', '9')],
    })
  ).id
  const e = api(employee, cafeId)
  const employeeSale = (
    await sell(e, {
      source: 'day_sheet',
      channelId: shop,
      businessDate: today,
      lines: [item(latte, '3', '18')],
    })
  ).id
  const oneSale = (
    await sell(b, {
      source: 'single',
      channelId: shop,
      businessDate: today,
      deliveryNeeded: true,
      deliveryArea: 'Dubai Marina',
      deliveryCost: '25',
      notes: 'Office order, floor 12',
      lines: [
        item(latte, '6', '18', { discount: { percent: '10' } }),
        { kind: 'delivery', id: randomUUID(), amount: '20' },
      ],
    })
  ).id
  const draftSale = (
    await sell(
      b,
      {
        source: 'single',
        channelId: shop,
        businessDate: today,
        lines: [item(croissant, '4', '9')],
      },
      false,
    )
  ).id
  const reversedSale = (
    await sell(b, {
      source: 'single',
      channelId: shop,
      locationId: marina,
      businessDate: today,
      lines: [item(latte, '2', '18')],
    })
  ).id
  await b.call('sale.reverse', { id: reversedSale })

  // Imports: Talabat's day at the Marina branch, posted; three days ago in the shop, waiting for
  // "Spanish Latte L" to be settled.
  async function importOf(
    channelId: string,
    locationId: string | null,
    day: string,
    file: string,
    rows: { name: string; qty: string; amount: string }[],
  ) {
    const id = randomUUID()
    await b.call('saleImport.create', {
      id,
      channelId,
      locationId,
      fileName: `${file}.csv`,
      fileHash: hashOf(`${file} ${id}`),
      fingerprint: hashOf('smoke summary layout'),
      shape: 'summary',
      periodFrom: day,
      periodTo: day,
      mapping: {
        headerRow: 0,
        columns: { name: 0, qty: 1, total: 2 },
        headers: { name: 'Item', qty: 'Items sold', total: 'Gross sales' },
        dateOrder: 'dmy',
      },
      amountsIncludeVat: true,
      rowsRead: rows.length,
      rowsLeftOut: 0,
      errors: [],
      feesTotal: null,
      rowCount: rows.length,
    })
    await b.call('saleImport.addRows', {
      id,
      rows: rows.map((row, position) => ({
        position,
        businessDate: day,
        name: row.name,
        code: null,
        qty: row.qty,
        amount: row.amount,
        refunds: '0',
        fileRows: 1,
      })),
    })
    return id
  }
  const yesterday = addDays(today, -1)
  const postedImport = await importOf(talabat, marina, yesterday, 'talabat-day', [
    { name: 'Spanish Latte', qty: '50', amount: '945' },
    { name: 'Croissant', qty: '10', amount: '94.5' },
  ])
  const posted = await b.query<{ data: { version: number } }>('saleImport.get', {
    id: postedImport,
  })
  await b.call('saleImport.post', { id: postedImport, version: posted.data.version })
  const imported = await b.query<{ data: { days: { saleIds: string[] }[] } }>('saleImport.get', {
    id: postedImport,
  })
  const draftImport = await importOf(shop, null, addDays(today, -3), 'pos-shop-day', [
    { name: 'Spanish Latte L', qty: '12', amount: '226.8' },
    { name: 'Croissant', qty: '8', amount: '75.6' },
  ])

  // A purchase on the supplier's credit, paid in full, then a piece returned: 10.00 overpaid, which
  // the supplier gives back ("Money back from the supplier", D-268).
  const supplier = randomUUID()
  await b.call('supplier.create', { id: supplier, name: 'Gulf Packaging Trading' })
  const cups = randomUUID()
  await b.call('material.create', { id: cups, name: 'Paper cups', unit: 'piece', packs: [] })
  const overpaidPurchase = randomUUID()
  const bought = await b.call<{ data: { version: number; lines: { id: string }[] } }>(
    'purchase.create',
    {
      id: overpaidPurchase,
      businessDate: today,
      documentType: 'no_invoice',
      paymentMethod: 'supplier_credit',
      supplierId: supplier,
      lines: [
        {
          kind: 'material',
          id: randomUUID(),
          materialId: cups,
          qty: '10',
          unit: 'piece',
          unitPrice: '10',
          vatRate: '0',
        },
      ],
    },
  )
  await b.call('purchase.post', { id: overpaidPurchase, version: bought.data.version })
  await b.call('purchasePayment.record', {
    id: randomUUID(),
    purchaseId: overpaidPurchase,
    businessDate: today,
    method: 'cash',
    amount: '100',
  })
  const returned = await b.call<{ data: { id: string; version: number } }>(
    'purchaseReturn.create',
    {
      id: randomUUID(),
      purchaseId: overpaidPurchase,
      kind: 'return',
      businessDate: today,
      lines: [{ id: randomUUID(), purchaseLineId: bought.data.lines[0]!.id, qty: '1' }],
    },
  )
  await b.call('purchaseReturn.post', { id: returned.data.id, version: returned.data.version })

  Object.assign(seed, {
    today,
    cafeId,
    latte,
    overpaidPurchase,
    employeeMemberId,
    talabatId: talabat,
    sheetSale,
    employeeSale,
    oneSale,
    draftSale,
    reversedSale,
    importedSale: imported.data.days[0]?.saleIds[0] ?? '',
    postedImport,
    draftImport,
  })
}

/** The home baker: customers, an order waiting, one delivered and refunded, one cancelled. */
async function seedBaker(owner: Page) {
  const bakerId = await createBusiness(owner, 'Smoke Bakes', BAKER_ANSWERS)
  const b = api(owner, bakerId)
  const { today } = await b.query<{ today: string }>('books.get')
  const kit = randomUUID()
  await b.call('material.create', { id: kit, name: 'Cake ingredients', unit: 'piece', packs: [] })
  await buy(b, addDays(today, -40), [
    { materialId: kit, qty: '50', unit: 'piece', unitPrice: '32.4' },
  ])
  const cake = await product(b, 'Chocolate cake', '150', { ownerMinutes: '60' })
  await b.call('recipe.save', {
    productId: cake,
    version: 0,
    lines: [{ id: randomUUID(), materialId: kit, qty: '1', unit: 'piece' }],
  })
  await b.call('productCost.updateSettings', { ownerHourlyRate: '40' })
  const fatima = (
    await b.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Fatima Saeed',
      phone: '050 123 4567',
    })
  ).id
  const mona = (
    await b.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Mona Khalil',
      phone: '055 765 4321',
    })
  ).id
  const order = (input: object) =>
    b.call<{ data: { id: string; version: number } }>('order.create', {
      id: randomUUID(),
      businessDate: today,
      ...input,
    })
  const cakeLine = () => item(cake, '1', '150')
  // #1001: waiting, delivery charged 20 (it costs her 25), a deposit of 50.
  const pending = await order({
    customerId: fatima,
    dueDate: addDays(today, 2),
    deliveryNeeded: true,
    deliveryArea: 'Al Barsha',
    deliveryCost: '25',
    notes: 'Happy birthday Sara',
    lines: [cakeLine(), { kind: 'delivery', id: randomUUID(), amount: '20' }],
    payment: { id: randomUUID(), method: 'bank_transfer', amount: '50' },
  })
  // #1002: two cakes, paid, delivered, then 20 off for a damaged one and given back.
  const delivered = await order({
    customerId: mona,
    lines: [item(cake, '2', '150')],
    payment: { id: randomUUID(), method: 'cash', amount: '300' },
  })
  const shipped = await b.call<{ data: { saleId: string } }>('order.deliver', {
    id: delivered.data.id,
    version: delivered.data.version,
  })
  const sale = await b.query<{ data: Sale }>('sale.get', { id: shipped.data.saleId })
  await b.call('sale.refund', {
    id: randomUUID(),
    orderId: delivered.data.id,
    by: 'amount',
    lines: [{ lineId: sale.data.lines[0]!.id, amount: '20' }],
    notes: 'Damaged on the way',
    payment: { id: randomUUID(), method: 'cash', amount: '20' },
  })
  // #1003: cancelled with its deposit of 50 still to give back.
  const cancelled = await order({
    customerId: fatima,
    lines: [cakeLine()],
    payment: { id: randomUUID(), method: 'cash', amount: '50' },
  })
  await b.call('order.cancel', {
    id: cancelled.data.id,
    version: cancelled.data.version,
    reason: 'Changed her mind',
  })
  Object.assign(seed, {
    bakerId,
    bakerCustomer: fatima,
    pendingOrder: pending.data.id,
    deliveredOrder: delivered.data.id,
    cancelledOrder: cancelled.data.id,
  })
}

/** The fit-out company: quotations, invoices, a credit note and payments. */
async function seedFitout(owner: Page) {
  const fitoutId = await createBusiness(owner, 'Smoke Interiors', FITOUT_ANSWERS)
  const b = api(owner, fitoutId)
  const { today } = await b.query<{ today: string }>('books.get')
  await taxReady(b, 'Smoke Interiors')
  const customer = (
    await b.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Gulf Towers LLC',
      kind: 'business',
      trn: '100555666700003',
      addressLine: 'Office 1402, Marina Plaza',
      city: 'Dubai Marina',
      emirate: 'dubai',
    })
  ).id
  const quotation = (input: object) =>
    b.call<{ id: string; version: number }>('quotation.create', {
      id: randomUUID(),
      customerId: customer,
      businessDate: today,
      ...input,
    })
  const draftQuotation = await quotation({
    lines: [typed('Gypsum partition', '120', '45', 'm2'), typed('Painting', '300', '18', 'm2')],
  })
  const sent = await quotation({ lines: [typed('Wall cladding, oak veneer', '12', '850', 'm2')] })
  await b.call('quotation.send', { id: sent.id, version: sent.version })
  const accepted = await quotation({
    lines: [typed('Reception fit-out', '1', '10000')],
    stages: [
      { label: 'On signing', due: 'On signing', percent: '30' },
      { label: null, due: 'On delivery', percent: '40' },
      { label: null, due: 'On handover', percent: '30' },
    ],
  })
  const acceptedSent = await b.call<{ id: string; version: number }>('quotation.send', {
    id: accepted.id,
    version: accepted.version,
  })
  await b.call('quotation.accept', {
    id: acceptedSent.id,
    version: acceptedSent.version,
    note: null,
  })
  // Answered and outdated: one declined, one revised (the first revision superseded by a draft), one
  // sent and past its validity (expired).
  const declined = await quotation({ lines: [typed('Ceiling works', '80', '120', 'm2')] })
  const declinedSent = await b.call<{ id: string; version: number }>('quotation.send', {
    id: declined.id,
    version: declined.version,
  })
  await b.call('quotation.decline', {
    id: declinedSent.id,
    version: declinedSent.version,
    reason: 'Went with another contractor',
  })
  const original = await quotation({ lines: [typed('Oak flooring', '60', '220', 'm2')] })
  await b.call('quotation.send', { id: original.id, version: original.version })
  const revision = await b.call<{ id: string }>('quotation.revise', {
    id: original.id,
    newId: randomUUID(),
  })
  const expired = await quotation({
    businessDate: addDays(today, -30),
    validUntil: addDays(today, -10),
    lines: [typed('Wallpaper', '40', '95', 'm2')],
  })
  await b.call('quotation.send', { id: expired.id, version: expired.version })
  const draftInvoice = await b.call<{ id: string }>('invoice.create', {
    id: randomUUID(),
    customerId: customer,
    lpoReference: 'LPO-7781',
    countedElsewhere: false,
    lines: [typed('Glass partitions for offices', '12', '850', 'm2')],
  })
  // The first stage invoiced and issued, part paid, then 300 taken back by a credit note.
  const stage = await b.call<{ id: string; version: number }>('invoice.fromQuotation', {
    id: accepted.id,
    newId: randomUUID(),
    stage: 0,
  })
  const issued = await b.call<{ id: string; version: number; lines: { id: string }[] }>(
    'invoice.issue',
    { id: stage.id, version: stage.version },
  )
  await b.call('customerPayment.record', {
    id: randomUUID(),
    invoiceId: issued.id,
    businessDate: today,
    method: 'bank_transfer',
    amount: '1000',
  })
  const credit = await b.call<{ id: string; version: number }>('creditNote.create', {
    id: randomUUID(),
    invoiceId: issued.id,
    eventDate: today,
    reason: 'price_changed',
    reasonText: 'Part of the reception was not fitted',
    by: 'amount',
    lines: [{ invoiceLineId: issued.lines[0]!.id, amount: '300' }],
  })
  await b.call('creditNote.issue', { id: credit.id, version: credit.version })
  Object.assign(seed, {
    fitoutId,
    fitCustomer: customer,
    draftQuotation: draftQuotation.id,
    sentQuotation: sent.id,
    declinedQuotation: declined.id,
    supersededQuotation: original.id,
    revisionQuotation: revision.id,
    expiredQuotation: expired.id,
    acceptedQuotation: accepted.id,
    draftInvoice: draftInvoice.id,
    issuedInvoice: issued.id,
  })
}

/** The factory: a deposit without its tax invoice, an invoice of a delivered order. */
async function seedFactory(owner: Page, employee: Page, employeeUser: TestUser) {
  const factoryId = await createBusiness(owner, 'Smoke Metal Works', FACTORY_ANSWERS)
  const b = api(owner, factoryId)
  const { today } = await b.query<{ today: string }>('books.get')
  await taxReady(b, 'Smoke Metal Works')
  const channelId = (await channels(b))[0]!.id
  const customer = (
    await b.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Gulf Build Contracting LLC',
      kind: 'business',
      trn: '100555666700003',
      addressLine: 'Office 12, Al Majaz Tower',
      city: 'Al Majaz',
      emirate: 'sharjah',
    })
  ).id
  const bracket = await product(b, 'Steel bracket', '35')
  const order = (lpo: string, qty: string, payment?: string) =>
    b.call<{ data: { id: string; version: number } }>('order.create', {
      id: randomUUID(),
      customerId: customer,
      customerRef: lpo,
      businessDate: today,
      channelId,
      lines: [item(bracket, qty, '35')],
      ...(payment
        ? { payment: { id: randomUUID(), method: 'bank_transfer', amount: payment } }
        : {}),
    })
  const shipped = await order('LPO-2231', '200')
  await b.call('order.deliver', { id: shipped.data.id, version: shipped.data.version })
  const draft = await b.call<{ id: string; version: number }>('invoice.fromOrder', {
    orderId: shipped.data.id,
    newId: randomUUID(),
  })
  const invoice = await b.call<{ id: string }>('invoice.issue', {
    id: draft.id,
    version: draft.version,
  })
  await order('LPO-2260', '300', '1000')
  // An accepted quotation, to be made an order; and an Employee, whose customer picker is masked.
  const quote = await b.call<{ id: string; version: number }>('quotation.create', {
    id: randomUUID(),
    customerId: customer,
    businessDate: today,
    lines: [typed('Steel brackets, galvanised', '500', '32')],
  })
  const quoteSent = await b.call<{ id: string; version: number }>('quotation.send', {
    id: quote.id,
    version: quote.version,
  })
  await b.call('quotation.accept', { id: quoteSent.id, version: quoteSent.version, note: null })
  await joinTeam(b, employee, employeeUser, 'employee')
  Object.assign(seed, { factoryId, factoryInvoice: invoice.id, factoryQuotation: quote.id })
}

/** The designer: a sale "they'll pay later", invoiced, and a plain credit note. */
async function seedDesigner(owner: Page) {
  const designerId = await createBusiness(owner, 'Smoke Design Studio', DESIGNER_ANSWERS)
  const b = api(owner, designerId)
  const { today } = await b.query<{ today: string }>('books.get')
  const customer = (
    await b.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Bloom Florists LLC',
      kind: 'business',
    })
  ).id
  const service = await product(b, 'Brand identity', '4500', { type: 'service' })
  const channelId = (await channels(b))[0]!.id
  const designerSale = (
    await sell(b, {
      source: 'single',
      channelId,
      businessDate: today,
      customerId: customer,
      payLater: true,
      lines: [item(service, '1', '4500')],
    })
  ).id
  const draft = await b.call<{ id: string; version: number }>('invoice.fromSale', {
    saleId: designerSale,
    newId: randomUUID(),
  })
  const invoice = await b.call<{ id: string; lines: { id: string }[] }>('invoice.issue', {
    id: draft.id,
    version: draft.version,
  })
  const credit = await b.call<{ id: string; version: number }>('creditNote.create', {
    id: randomUUID(),
    invoiceId: invoice.id,
    eventDate: today,
    reason: 'price_changed',
    reasonText: 'One logo version dropped',
    by: 'amount',
    lines: [{ invoiceLineId: invoice.lines[0]!.id, amount: '500' }],
  })
  await b.call('creditNote.issue', { id: credit.id, version: credit.version })
  Object.assign(seed, { designerId, designerSale, designerInvoice: invoice.id })
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000)
  const ownerUser = await createUser('m3smoke-owner')
  const employeeUser = await createUser('m3smoke-employee')
  users.push(ownerUser, employeeUser)
  pages.owner = await openAs(browser, ownerUser, 'Layla Haddad')
  pages.employee = await openAs(browser, employeeUser, 'Omar Saleh')
  await seedCafe(pages.owner, pages.employee, employeeUser)
  await seedBaker(pages.owner)
  await seedFitout(pages.owner)
  await seedFactory(pages.owner, pages.employee, employeeUser)
  await seedDesigner(pages.owner)
  // A workshop with nothing entered yet: every M3 list empty.
  seed.emptyId = await createBusiness(pages.owner, 'Smoke Joinery', WORKSHOP_ANSWERS)
})

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

const cafe = (path = '') => `/b/${seed.cafeId}${path}`
const baker = (path = '') => `/b/${seed.bakerId}${path}`
const fitout = (path = '') => `/b/${seed.fitoutId}${path}`
const factory = (path = '') => `/b/${seed.factoryId}${path}`
const designer = (path = '') => `/b/${seed.designerId}${path}`
const empty = (path = '') => `/b/${seed.emptyId}${path}`

const mainNav = ({ page, L }: Context) =>
  page.getByRole('navigation', { name: L('Main', 'القائمة الرئيسية') })

/** The open dialog (a sheet, a side panel or a confirmation). */
const dialog = (page: Page) => page.getByRole('dialog').or(page.getByRole('alertdialog'))

/** Clicks the button named `name` (exactly), then waits for a dialog. */
async function opens({ page }: Context, name: string) {
  await page
    .getByRole('main')
    .getByRole('button', { name, exact: true })
    .first()
    .click({ timeout: 15_000 })
  await expect(dialog(page)).toBeVisible()
}

/** The label of a choice (a radio drawn as a button): what a person taps. */
const choice = (page: Page, name: string) =>
  page.locator('label').filter({ has: page.getByRole('radio', { name, exact: true }) })

const SCREENS: Screen[] = [
  // The shell: "Add new" with sales, orders, customers, quotations and invoices; the phone's "More".
  {
    name: 'cafe-add-new',
    who: 'owner',
    path: () => cafe(),
    open: async (context) => {
      await mainNav(context)
        .getByRole('button', { name: context.L('Add new', 'إضافة جديد') })
        .click()
      await expect(
        context.page.getByRole('menuitem', { name: context.L("Today's sales", 'مبيعات اليوم') }),
      ).toBeVisible()
    },
  },
  {
    name: 'fitout-add-new',
    who: 'owner',
    path: () => fitout(),
    open: async (context) => {
      await mainNav(context)
        .getByRole('button', { name: context.L('Add new', 'إضافة جديد') })
        .click()
      await expect(
        context.page.getByRole('menuitem', { name: context.L('New invoice', 'فاتورة جديدة') }),
      ).toBeVisible()
    },
  },
  {
    name: 'baker-more',
    who: 'owner',
    widths: [375],
    path: () => baker(),
    open: async (context) => {
      await mainNav(context)
        .getByRole('button', { name: context.L('More', 'المزيد') })
        .click()
      await expect(context.page.getByRole('menuitem').first()).toBeVisible()
    },
  },

  // The Dashboard's cards.
  { name: 'cafe-dashboard', who: 'owner', path: () => cafe() },
  { name: 'baker-dashboard', who: 'owner', path: () => baker() },
  { name: 'factory-dashboard', who: 'owner', path: () => factory() },
  { name: 'employee-dashboard', who: 'employee', path: () => cafe() },

  // Sales.
  { name: 'sales', who: 'owner', path: () => cafe('/sales') },
  { name: 'sales-imports', who: 'owner', path: () => cafe('/sales?view=imports') },
  { name: 'sales-today', who: 'owner', path: () => cafe('/sales/today') },
  {
    name: 'sales-today-change',
    who: 'owner',
    path: () => cafe('/sales/today'),
    open: async ({ page, L }) => {
      const change = page.getByRole('button', { name: L('Change', 'تغيير'), exact: true })
      if (await change.isVisible()) await change.click()
      await expect(page.getByRole('combobox', { name: L('Channel', 'قناة البيع') })).toBeVisible()
    },
  },
  {
    name: 'sales-today-days',
    who: 'owner',
    path: () => {
      const last = monthsBefore(seed.today)
      return cafe(`/sales/today?date=${lastDayOf(last)}&from=${last}-01`)
    },
  },
  { name: 'sale-new', who: 'owner', path: () => cafe('/sales/new') },
  {
    name: 'sale-new-delivery',
    who: 'owner',
    path: () => cafe('/sales/new'),
    open: async ({ page, L }) => {
      await choice(page, L('Yes', 'نعم')).click()
      await expect(
        page.getByRole('textbox', { name: L('What the delivery cost you', 'ما كلّفك التوصيل') }),
      ).toBeVisible()
    },
  },
  { name: 'sale', who: 'owner', path: () => cafe(`/sales/${seed.oneSale}`) },
  {
    name: 'sale-reverse',
    who: 'owner',
    path: () => cafe(`/sales/${seed.oneSale}`),
    open: async (context) => opens(context, context.L('Reverse', 'أبطِل')),
  },
  {
    name: 'sale-refund',
    who: 'owner',
    path: () => cafe(`/sales/${seed.oneSale}`),
    open: async (context) => opens(context, context.L('Refund', 'استرجاع')),
  },
  { name: 'sale-sheet', who: 'owner', path: () => cafe(`/sales/${seed.sheetSale}`) },
  { name: 'sale-draft', who: 'owner', path: () => cafe(`/sales/${seed.draftSale}`) },
  { name: 'sale-reversed', who: 'owner', path: () => cafe(`/sales/${seed.reversedSale}`) },
  { name: 'sale-imported', who: 'owner', path: () => cafe(`/sales/${seed.importedSale}`) },
  { name: 'import-new', who: 'owner', path: () => cafe('/sales/import') },
  {
    name: 'import-columns',
    who: 'owner',
    path: () => cafe('/sales/import'),
    open: async ({ page }) => {
      await expect(page.locator('[data-pick-file], [data-file-name]').first()).toBeVisible()
      const file = csv('pos-day.csv', [
        'Item,Items sold,Gross sales',
        'Spanish Latte,12,226.80',
        'Croissant,8,75.60',
      ])
      for (let attempt = 0; attempt < 5; attempt++) {
        await page.locator('input[type=file]').first().setInputFiles(file)
        if (await page.locator('[data-file-name]').isVisible()) break
        await page.waitForTimeout(500)
      }
      await page.locator('[data-next]').click()
      await expect(page.locator('[data-read-summary]')).toBeVisible()
    },
  },
  { name: 'import-names', who: 'owner', path: () => cafe(`/sales/import/${seed.draftImport}`) },
  { name: 'import-posted', who: 'owner', path: () => cafe(`/sales/import/${seed.postedImport}`) },

  // What an employee sees of Sales: their own, no costs, no Real profit.
  { name: 'employee-sales', who: 'employee', path: () => cafe('/sales') },
  { name: 'employee-today', who: 'employee', path: () => cafe('/sales/today') },
  { name: 'employee-sale', who: 'employee', path: () => cafe(`/sales/${seed.employeeSale}`) },
  { name: 'employee-profit', who: 'employee', path: () => cafe('/reports/profit') },

  // Reports → Real profit.
  {
    name: 'profit',
    who: 'owner',
    path: () => cafe('/reports/profit?period=last_month&by=product'),
  },
  {
    name: 'profit-channel',
    who: 'owner',
    path: () => cafe('/reports/profit?period=last_month&by=channel'),
  },
  {
    name: 'profit-branch',
    who: 'owner',
    path: () => cafe('/reports/profit?period=last_month&by=branch'),
  },
  {
    name: 'profit-week',
    who: 'owner',
    path: () => cafe('/reports/profit?period=last_month&by=week'),
  },
  { name: 'profit-day', who: 'owner', path: () => cafe('/reports/profit?by=day') },
  { name: 'baker-profit-order', who: 'owner', path: () => baker('/reports/profit?by=order') },

  // Orders, Customers and What customers owe.
  { name: 'orders', who: 'owner', path: () => baker('/orders') },
  { name: 'order-new', who: 'owner', path: () => baker('/orders/new') },
  { name: 'order', who: 'owner', path: () => baker(`/orders/${seed.pendingOrder}`) },
  {
    name: 'order-deliver',
    who: 'owner',
    path: () => baker(`/orders/${seed.pendingOrder}`),
    open: async (context) => opens(context, context.L('Deliver', 'سلّم الطلب')),
  },
  {
    name: 'order-pay',
    who: 'owner',
    path: () => baker(`/orders/${seed.pendingOrder}`),
    open: async (context) => opens(context, context.L('Record a payment', 'سجّل دفعة')),
  },
  {
    name: 'order-cancel',
    who: 'owner',
    path: () => baker(`/orders/${seed.pendingOrder}`),
    open: async (context) => opens(context, context.L('Cancel order', 'ألغِ الطلب')),
  },
  { name: 'order-edit', who: 'owner', path: () => baker(`/orders/${seed.pendingOrder}/edit`) },
  { name: 'order-delivered', who: 'owner', path: () => baker(`/orders/${seed.deliveredOrder}`) },
  {
    name: 'order-refund',
    who: 'owner',
    path: () => baker(`/orders/${seed.deliveredOrder}`),
    open: async (context) => opens(context, context.L('Refund', 'استرجاع')),
  },
  {
    name: 'order-undo',
    who: 'owner',
    path: () => baker(`/orders/${seed.deliveredOrder}`),
    open: async (context) => opens(context, context.L('Undo delivery', 'تراجع عن التسليم')),
  },
  { name: 'order-cancelled', who: 'owner', path: () => baker(`/orders/${seed.cancelledOrder}`) },
  {
    name: 'order-money-back',
    who: 'owner',
    path: () => baker(`/orders/${seed.cancelledOrder}`),
    open: async (context) => opens(context, context.L('Give money back', 'أعد المبلغ')),
  },
  {
    // The Employee's order editor: their customer picker shows names and a phone's last digits.
    name: 'employee-order-new',
    who: 'employee',
    path: () => factory('/orders/new'),
    open: async ({ page, L }) => {
      await page.getByRole('combobox', { name: L('Customer', 'العميل') }).fill('Gulf')
      await expect(page.getByRole('option').first()).toBeVisible()
    },
  },
  { name: 'customers', who: 'owner', path: () => baker('/customers') },
  {
    name: 'customer-new',
    who: 'owner',
    path: () => baker('/customers/new'),
    open: async ({ page }) => {
      await expect(dialog(page)).toBeVisible()
    },
  },
  { name: 'customer', who: 'owner', path: () => baker(`/customers/${seed.bakerCustomer}`) },
  {
    name: 'customer-statement',
    who: 'owner',
    path: () => baker(`/customers/${seed.bakerCustomer}/statement`),
  },
  { name: 'receivables', who: 'owner', path: () => baker('/receivables') },
  {
    name: 'receivables-pay-many',
    who: 'owner',
    path: () => baker('/receivables'),
    open: async (context) => opens(context, context.L('Record a payment', 'سجّل دفعة')),
  },

  // Quotations.
  { name: 'quotations', who: 'owner', path: () => fitout('/quotations') },
  { name: 'quotation-new', who: 'owner', path: () => fitout('/quotations/new') },
  {
    name: 'quotation-draft',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.draftQuotation}`),
  },
  {
    name: 'quotation-edit',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.draftQuotation}/edit`),
  },
  { name: 'quotation-sent', who: 'owner', path: () => fitout(`/quotations/${seed.sentQuotation}`) },
  {
    name: 'quotation-accept',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.sentQuotation}`),
    open: async (context) => opens(context, context.L('Mark accepted', 'تسجيل القبول')),
  },
  {
    name: 'quotation-accepted',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.acceptedQuotation}`),
  },
  {
    name: 'quotation-decline',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.sentQuotation}`),
    open: async (context) => opens(context, context.L('Mark declined', 'تسجيل الرفض')),
  },
  {
    name: 'quotation-revise',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.sentQuotation}`),
    open: async (context) => opens(context, context.L('Revise', 'نسخة معدّلة')),
  },
  {
    name: 'quotation-copy',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.sentQuotation}`),
    open: async (context) =>
      opens(context, context.L('Copy to a new quotation', 'نسخ إلى عرض سعر جديد')),
  },
  {
    name: 'quotation-declined',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.declinedQuotation}`),
  },
  {
    name: 'quotation-superseded',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.supersededQuotation}`),
  },
  {
    name: 'quotation-revision',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.revisionQuotation}`),
  },
  {
    name: 'quotation-expired',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.expiredQuotation}`),
  },
  { name: 'quotations-expired', who: 'owner', path: () => fitout('/quotations?status=expired') },
  {
    name: 'quotation-to-order',
    who: 'owner',
    path: () => factory(`/quotations/${seed.factoryQuotation}`),
    open: async (context) => opens(context, context.L('Make an order', 'تحويله إلى طلب')),
  },
  {
    name: 'quotation-bill',
    who: 'owner',
    path: () => fitout(`/quotations/${seed.acceptedQuotation}`),
    open: async (context) => opens(context, context.L('Make an invoice', 'إنشاء فاتورة')),
  },

  // Invoices, credit notes and statements.
  { name: 'invoices', who: 'owner', path: () => fitout('/invoices') },
  { name: 'invoice-new', who: 'owner', path: () => fitout('/invoices/new') },
  { name: 'invoice-draft', who: 'owner', path: () => fitout(`/invoices/${seed.draftInvoice}`) },
  {
    name: 'invoice-issue',
    who: 'owner',
    path: () => fitout(`/invoices/${seed.draftInvoice}`),
    open: async (context) => opens(context, context.L('Issue', 'إصدار')),
  },
  {
    name: 'invoice-edit',
    who: 'owner',
    path: () => fitout(`/invoices/${seed.draftInvoice}/edit`),
  },
  { name: 'invoice', who: 'owner', path: () => fitout(`/invoices/${seed.issuedInvoice}`) },
  {
    name: 'invoice-pay',
    who: 'owner',
    path: () => fitout(`/invoices/${seed.issuedInvoice}`),
    open: async (context) => opens(context, context.L('Record a payment', 'سجّل دفعة')),
  },
  {
    name: 'invoice-credit-note',
    who: 'owner',
    path: () => fitout(`/invoices/${seed.issuedInvoice}`),
    open: async (context) => opens(context, context.L('Credit note', 'إشعار دائن')),
  },
  {
    name: 'invoice-pdf',
    who: 'owner',
    path: () => fitout(`/invoices/${seed.issuedInvoice}`),
    open: async (context) => {
      await opens(context, context.L('Download or share PDF', 'تنزيل PDF أو مشاركته'))
      // Made once it can be downloaded (a phone shows no preview).
      await expect(
        dialog(context.page).getByRole('button', {
          name: context.L('Download PDF', 'تنزيل PDF'),
        }),
      ).toBeEnabled({ timeout: 60_000 })
    },
  },
  {
    name: 'statement',
    who: 'owner',
    path: () => fitout(`/customers/${seed.fitCustomer}/statement`),
  },
  { name: 'factory-invoices', who: 'owner', path: () => factory('/invoices') },
  {
    name: 'factory-invoice',
    who: 'owner',
    path: () => factory(`/invoices/${seed.factoryInvoice}`),
  },
  { name: 'designer-sale', who: 'owner', path: () => designer(`/sales/${seed.designerSale}`) },
  {
    name: 'designer-invoice',
    who: 'owner',
    path: () => designer(`/invoices/${seed.designerInvoice}`),
  },
  { name: 'designer-receivables', who: 'owner', path: () => designer('/receivables') },

  // M3 states on released M2 screens: the running-cost share on Product costs, an expense that is a
  // channel's app fees, money back from the supplier on an overpaid purchase.
  { name: 'product-costs', who: 'owner', path: () => cafe('/product-costs') },
  { name: 'product-cost-rate', who: 'owner', path: () => cafe(`/product-costs/${seed.latte}`) },
  {
    name: 'expense-new-fees',
    who: 'owner',
    path: () => cafe('/expenses/new'),
    open: async ({ page }) => {
      await expect(page.locator('[data-pays-option^="fees:"]').first()).toBeVisible()
    },
  },
  {
    name: 'purchase-overpaid',
    who: 'owner',
    path: () => cafe(`/purchases/${seed.overpaidPurchase}`),
  },
  {
    name: 'purchase-money-back',
    who: 'owner',
    path: () => cafe(`/purchases/${seed.overpaidPurchase}`),
    open: async (context) =>
      opens(context, context.L('Record money back from the supplier', 'سجّل مبلغًا أعاده المورّد')),
  },

  // Settings.
  { name: 'settings', who: 'owner', path: () => cafe('/settings') },
  { name: 'settings-channels', who: 'owner', path: () => cafe('/settings/channels') },
  {
    name: 'settings-channel-add',
    who: 'owner',
    path: () => cafe('/settings/channels'),
    open: async (context) => opens(context, context.L('Add a channel', 'إضافة قناة')),
  },
  {
    name: 'settings-channel-statements',
    who: 'owner',
    path: () => cafe(`/settings/channels/${seed.talabatId}`),
  },
  {
    name: 'settings-member-branches',
    who: 'owner',
    path: () => cafe(`/settings/members/${seed.employeeMemberId}`),
  },
  { name: 'settings-documents', who: 'owner', path: () => fitout('/settings/documents') },
  { name: 'baker-settings-documents', who: 'owner', path: () => baker('/settings/documents') },

  // Nothing entered yet: each list empty, and what to do first.
  { name: 'empty-sales', who: 'owner', path: () => empty('/sales') },
  { name: 'empty-imports', who: 'owner', path: () => empty('/sales?view=imports') },
  { name: 'empty-orders', who: 'owner', path: () => empty('/orders') },
  { name: 'empty-customers', who: 'owner', path: () => empty('/customers') },
  { name: 'empty-receivables', who: 'owner', path: () => empty('/receivables') },
  { name: 'empty-quotations', who: 'owner', path: () => empty('/quotations') },
  { name: 'empty-invoices', who: 'owner', path: () => empty('/invoices') },
  { name: 'empty-profit', who: 'owner', path: () => empty('/reports/profit') },
  { name: 'empty-dashboard', who: 'owner', path: () => empty() },
]

/**
 * Screenshots into E2E_SHOTS_DIR (only when it is set): the whole page, with the phone's tab bar at
 * its end and without toasts; with a dialog or menu open, the screen as it is.
 */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const open = await page
    .getByRole('dialog')
    .or(page.getByRole('alertdialog'))
    .or(page.getByRole('menu'))
    .count()
  // From the top: the shell's sticky bars stay at the top of the image.
  if (open === 0) await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: join(dir, `${name}.png`),
    fullPage: open === 0,
    style:
      open === 0
        ? 'nav.fixed.bottom-0 { position: static !important } [data-sonner-toaster] { display: none !important }'
        : '[data-sonner-toaster] { display: none !important }',
  })
}

for (const locale of LOCALES) {
  test.describe(locale === 'ar' ? 'Arabic (RTL)' : 'English (LTR)', () => {
    test.beforeAll(async () => {
      for (const page of Object.values(pages)) await setLanguage(page, locale)
    })

    for (const size of WIDTHS) {
      test(`every M3 screen at ${size.width} px`, async () => {
        test.setTimeout(600_000)
        for (const page of Object.values(pages)) await page.setViewportSize(size)
        const L = (en: string, ar: string) => (locale === 'ar' ? ar : en)
        for (const screen of SCREENS) {
          if (screen.widths && !screen.widths.includes(size.width)) continue
          await test.step(screen.name, async () => {
            const page = pages[screen.who]
            const path = screen.path()
            await page.goto(path)
            const what = `${screen.name} (${locale}, ${size.width} px)`
            await expect
              .soft(page.locator('h1:visible').first(), `${what}: a visible h1`)
              .toBeVisible()
            await settle(page)
            await screen.open?.({ page, width: size.width, L })
            await settle(page)
            // The screen itself, not a redirect or "Page not found".
            expect
              .soft(new URL(page.url()).pathname, `${what}: stayed on the screen`)
              .toBe(path.split('?')[0])
            await expect
              .soft(
                page.getByRole('heading', {
                  level: 1,
                  name: L('Page not found', 'الصفحة غير موجودة'),
                }),
                `${what}: not "Page not found"`,
              )
              .toHaveCount(0)
            const seen = await auditScreen(page)
            expect.soft(seen.lang, `${what}: lang`).toBe(locale)
            expect.soft(seen.dir, `${what}: dir`).toBe(locale === 'ar' ? 'rtl' : 'ltr')
            expect.soft(seen.sideways, `${what}: wider than the screen`).toBeLessThanOrEqual(0)
            expect.soft(seen.outside, `${what}: drawn past the screen's sides`).toEqual([])
            const text = seen.text.replace(/\S+@\S+/g, '')
            const names = seen.attributes.replace(/\S+@\S+/g, '')
            expect.soft(RAW_KEY.exec(text)?.[0], `${what}: an untranslated key`).toBeUndefined()
            expect
              .soft(RAW_KEY.exec(names)?.[0], `${what}: an untranslated key in a name`)
              .toBeUndefined()
            expect.soft(`${text}\n${names}`, `${what}: a placeholder`).not.toMatch(/\{\{|\}\}/)
            expect
              .soft(text, `${what}: a broken value`)
              .not.toMatch(/\bNaN\b|\bundefined\b|\[object Object\]|\bnull\b/)
            if (locale === 'ar') {
              expect.soft(/[؀-ۿ]/.test(text), `${what}: Arabic text`).toBe(true)
            } else {
              const arabic = text.replaceAll('العربية', '').match(/[؀-ۿ]+/g)
              expect.soft(arabic, `${what}: Arabic in the English page`).toBeNull()
            }
            await shot(page, `${locale}-${size.width}-${screen.name}`)
          })
        }
      })
    }
  })
}
