// Writes the PDF CLI's samples (M3 Step 7) through the same builder the API uses
// (buildQuotationPdfInput), so a sample is always shaped as the server makes it:
//
//   pnpm --filter @bizcost/api pdf:samples
//
// scripts/samples/fit-out-quotation.json: the demo fit-out company (Modern Touch Interiors, لمسة عصرية
// للديكور, VAT-registered, its letterhead in Arabic first, a generated logo, black accent as the owner's
// own letterhead) quoting a villa's joinery by room: 20 lines in 7 areas, with pictures of every shape
// (4:3, a panorama, tall, square and tiny ones, each printed in the same frame) and long area names (one
// on a single line without a picture), a total rounded to 83,900.00 and payment stages 50/35/15, an area
// across the page break (D-299). scripts/samples/workshop-quotation.json: the
// demo carpentry workshop (Al Itqan Carpentry) in English, without a logo or pictures, a draft.
// Step 8 (made by the API's own builders): tax-invoice.json, tax-credit-note.json,
// workshop-final-invoice.json, designer-invoice.json and factory-statement.json (see below). D-360's
// columns, through the sales engine: mixed-rates-invoice.json (5 %, zero-rated and exempt, amounts in
// the hundreds of millions, a total rounded), vat-inclusive-invoice.json (prices with VAT, a document
// discount, a total rounded) and fit-out-invoice.json (areas and pictures over two pages).
// Every business, customer and figure here is fictional (the demo personas), never a real customer.
// Amounts are worked out in fils (whole numbers), never in floating point.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeSale,
  solveRoundAmount,
  sumDecimals,
  type Money,
  type Percent,
  type Quantity,
  type SaleInput,
  type VatCategory,
} from '@bizcost/domain'
import {
  buildCreditNotePdfInput,
  buildInvoicePdfInput,
  buildQuotationPdfInput,
  buildStatementPdfInput,
  type PdfBusiness,
  type PdfInvoice,
  type PdfInvoiceLine,
  type PdfQuotation,
} from '../src/documents/pdf/build'
import type { DocumentPdfImage, DocumentPdfInput } from '../src/documents/pdf/input'

const samples = join(fileURLToPath(new URL('.', import.meta.url)), 'samples')

/** The image keys the CLI fills from scripts/samples/images (their size is read there). */
const image = (key: string, format: 'png' | 'jpg'): DocumentPdfImage => ({
  path: `/img/${key}.${format}`,
  format,
  width: 1,
  height: 1,
})

/** Fils of "12025.5". */
const fils = (value: string) => {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2))
}
/** "12025.50" of fils. */
const amount = (value: bigint) => {
  const sign = value < 0n ? '-' : ''
  const abs = value < 0n ? -value : value
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}
/** qty × price in fils, half up (qty up to 3 decimals). */
const times = (qty: string, price: string) => {
  const [whole = '0', fraction = ''] = qty.split('.')
  const thousandths = BigInt(whole) * 1000n + BigInt(`${fraction}000`.slice(0, 3))
  return (thousandths * fils(price) + 500n) / 1000n
}
const vat5 = (net: bigint) => (net * 5n + 50n) / 100n

interface SampleLine {
  readonly area: string | null
  readonly title: string
  readonly details: string | null
  readonly note?: string
  readonly qty: string
  readonly unit: PdfQuotation['lines'][number]['unit']
  readonly price: string
  readonly picture?: string
}

/**
 * A quotation of `lines` at 5 % VAT: "Round the total" to `wanted` (the largest total not above it),
 * and stages sharing the amount to pay (the last takes the rest).
 */
function quotation(
  lines: readonly SampleLine[],
  options: Pick<
    PdfQuotation,
    | 'number'
    | 'revision'
    | 'draft'
    | 'businessDate'
    | 'validUntil'
    | 'customerRef'
    | 'site'
    | 'greeting'
    | 'intro'
    | 'terms'
    | 'notes'
  > & {
    readonly wanted: string | null
    readonly stages: readonly { label: string | null; due: string; percent: bigint }[]
  },
): PdfQuotation {
  const nets = lines.map((line) => times(line.qty, line.price))
  const lineNet = nets.reduce((sum, net) => sum + net, 0n)
  let adjustment = 0n
  let difference = 0n
  if (options.wanted !== null) {
    const wanted = fils(options.wanted)
    let net = (wanted * 100n) / 105n + 5n
    while (net + vat5(net) > wanted) net -= 1n
    adjustment = net - lineNet
    difference = wanted - (net + vat5(net))
  }
  const net = lineNet + adjustment
  const vat = vat5(net)
  const payable = net + vat + difference
  let left = payable
  const stages = options.stages.map((stage, i) => {
    const share = i === options.stages.length - 1 ? left : (payable * stage.percent + 50n) / 100n
    left -= share
    return {
      label: stage.label,
      due: stage.due,
      percent: String(stage.percent),
      amount: amount(share),
    }
  })
  return {
    ...options,
    currency: 'AED',
    vatRegistered: true,
    subtotal: amount(lineNet),
    discountTotal: '0',
    adjustment: amount(adjustment),
    roundingDifference: amount(difference),
    netTotal: amount(net),
    vatTotal: amount(vat),
    total: amount(net + vat),
    payable: amount(payable),
    vatRates: [{ vatCategory: 'standard', vatRate: '5', net: amount(net), vat: amount(vat) }],
    issuedAt: new Date(`${options.businessDate}T09:30:00Z`),
    lines: lines.map((line, i) => ({
      area: line.area,
      title: line.title,
      details: line.details,
      note: line.note ?? null,
      qty: line.qty,
      unit: line.unit,
      unitPrice: line.price,
      subtotal: amount(nets[i]!),
      lineDiscount: '0',
      priceIncludesVat: false,
      vatCategory: 'standard',
      vatRate: '5',
      picture: line.picture ?? null,
    })),
    stages,
  }
}

const fitOutLines: readonly SampleLine[] = [
  {
    area: 'MAJLIS',
    title: 'Wall cladding with hidden door',
    details:
      'Material: MDF with oak veneer, matt lacquer\nHidden door 90 × 240 cm, soft-close hinges\nLED strip along the top',
    qty: '18.5',
    unit: 'm2',
    price: '650',
    picture: 'line-1',
  },
  {
    area: 'MAJLIS',
    title: 'TV unit with back panel',
    details: 'Material: plywood, white high gloss\nFittings: Blum push-to-open',
    note: '* Marble top price to be added as per client selection + delivery',
    qty: '1',
    unit: 'piece',
    price: '7800',
    picture: 'line-2',
  },
  {
    area: 'MAJLIS',
    title: 'Floating wall shelves',
    details: 'Material: solid oak, natural oil\n4 shelves on hidden brackets',
    qty: '3.6',
    unit: 'm',
    price: '420',
    picture: 'line-3',
  },
  {
    area: 'غرفة الطعام',
    title: 'خزانة عرض بأبواب زجاجية',
    details: 'الخامة: قشرة بلوط وزجاج شفاف\nإضاءة داخلية ورفّان زجاجيان',
    qty: '2.4',
    unit: 'm',
    price: '1850',
    picture: 'line-4',
  },
  {
    area: 'غرفة الطعام',
    title: 'بوفيه',
    details: 'الخامة: قشرة جوز\nالإكسسوارات: أدراج Hettich بإغلاق هادئ',
    qty: '1',
    unit: 'piece',
    price: '5200',
    picture: 'line-5',
  },
  {
    area: 'غرفة الطعام',
    title: 'تكسية الجدار خلف طاولة الطعام',
    details: 'الخامة: MDF مدهون بحفر V\nاللون حسب العيّنة المعتمدة',
    qty: '9.2',
    unit: 'm2',
    price: '380',
    picture: 'line-6',
  },
  {
    area: 'Master BR',
    title: 'Wardrobe with sliding doors',
    details:
      'Material: MDF painted, inside melamine\nTinted mirror on the middle door\nFittings: Hettich soft-close',
    qty: '6.8',
    unit: 'm2',
    price: '980',
    picture: 'line-7',
  },
  {
    area: 'Master BR',
    title: 'Bed back panel with side tables',
    details: 'Material: fabric panels on MDF frame\n2 side tables, one drawer each',
    qty: '1',
    unit: 'piece',
    price: '4750',
    picture: 'line-8',
  },
  {
    area: 'Master BR',
    title: 'Dressing table with mirror',
    details: 'Material: oak veneer\nOval mirror with LED',
    qty: '1',
    unit: 'piece',
    price: '2300',
    picture: 'line-9',
  },
  {
    // Past page 1: the area's name is written again on page 2 (D-299).
    area: 'Master BR',
    title: 'Shoe cabinet by the door',
    details: 'Material: MDF painted\nTilt-out shelves, ventilated back',
    qty: '1.6',
    unit: 'm',
    price: '1150',
    picture: 'line-10',
  },
  {
    area: 'Room 1',
    title: 'Wardrobe, hinged doors',
    details: 'Material: MDF painted\nInside: melamine, hanging rails and 3 drawers',
    qty: '4.5',
    unit: 'm2',
    price: '850',
    picture: 'line-10',
  },
  {
    area: 'Room 1',
    title: 'Study desk with wall shelves',
    details: 'Material: plywood, oak laminate\nCable tray under the desk',
    qty: '1',
    unit: 'piece',
    price: '2650',
    picture: 'line-11',
  },
  {
    area: 'Room 1',
    title: 'Curtain pelmet',
    details: 'Material: MDF painted\nFor a curtain track (track not included)',
    qty: '3.2',
    unit: 'm',
    price: '180',
  },
  {
    area: 'Pantry',
    title: 'Base cabinets with quartz top',
    details:
      'Material: moisture-resistant MDF, matt lacquer\nTop: quartz 20 mm\nFittings: Blum Tandembox drawers',
    qty: '4.2',
    unit: 'm',
    price: '1650',
    picture: 'line-12',
  },
  {
    area: 'Pantry',
    title: 'Upper cabinets',
    details: 'Material: moisture-resistant MDF, matt lacquer\nLift-up doors with gas struts',
    qty: '4.2',
    unit: 'm',
    price: '950',
    picture: 'line-14',
  },
  {
    area: 'Pantry',
    title: 'Tall unit for oven and fridge',
    details: 'Material: moisture-resistant MDF\nOpenings as per the appliance sizes',
    qty: '2',
    unit: 'piece',
    price: '2400',
  },
  // D-299's variety: a long area name on one line without a picture (smaller, on two lines), a long
  // Arabic one, and pictures of every shape (square, tall, tiny) printed in the same frame.
  {
    area: 'Guest bathroom – ground floor',
    title: 'Vanity unit',
    details: 'Material: moisture-resistant MDF, matt lacquer',
    qty: '1',
    unit: 'piece',
    price: '1950',
  },
  {
    area: 'غرفة النوم الرئيسية – الطابق الأول',
    title: 'خزانة بياضات طويلة',
    details: 'الخامة: MDF مدهون\nرفوف داخلية ودرج سفلي',
    qty: '1',
    unit: 'piece',
    price: '3100',
    picture: 'line-17',
  },
  {
    area: 'غرفة النوم الرئيسية – الطابق الأول',
    title: 'طاولة جانبية دائرية',
    details: 'الخامة: خشب جوز صلب',
    qty: '2',
    unit: 'piece',
    price: '650',
    picture: 'line-15',
  },
  {
    area: null,
    title: 'Mirror frame',
    details: 'Material: brass-finish aluminium',
    qty: '1',
    unit: 'piece',
    price: '780',
    picture: 'line-16',
  },
]

const pictureKeys = [...new Set(fitOutLines.flatMap((line) => line.picture ?? []))]

const fitOut = buildQuotationPdfInput({
  business: {
    legalName: 'Modern Touch Interiors',
    legalNameAr: 'لمسة عصرية للديكور',
    locale: 'ar',
    vatRegistered: true,
    trn: '100345678900003',
    phone: '+971 4 555 0142',
    phone2: '+971 50 555 0199',
    email: 'hello@moderntouch.example',
    addressLine: 'Warehouse 7, Al Quoz Industrial 3',
    city: null,
    emirate: 'dubai',
    tradeLicenceNo: 'DED-884210',
    accent: 'black',
    watermark: true,
    wholeAmounts: false,
    signatory: 'عبدالله الكعبي',
    footer:
      'Bank: Emirates Sample Bank\nAccount name: Modern Touch Interiors\nIBAN: AE00 0000 0000 0000 0000 000',
  },
  quotation: quotation(fitOutLines, {
    number: 'Q-0007',
    revision: 2,
    draft: false,
    businessDate: '2026-10-08',
    validUntil: '2026-10-15',
    customerRef: 'ENQ-2026-118',
    site: 'Villa 18, Al Barsha South',
    greeting: null,
    intro: null,
    terms:
      'Prices include supply and installation at site.\nThe client provides power and access during working hours.\nColours and finishes as per the approved samples.\nAny extra work is quoted separately.',
    notes: null,
    wanted: '83900',
    stages: [
      { label: null, due: 'عند التوقيع', percent: 50n },
      { label: null, due: 'عند التوريد', percent: 35n },
      { label: null, due: 'بعد التسليم', percent: 15n },
    ],
  }),
  customer: {
    name: 'يوسف الحمادي',
    phone: '+971 55 555 0123',
    trn: null,
    addressLine: null,
    city: null,
    emirate: null,
  },
  businessImages: { logo: 'logo', signature: 'signature', stamp: 'stamp' },
  images: {
    logo: image('logo', 'png'),
    signature: image('signature', 'png'),
    stamp: image('stamp', 'png'),
    ...Object.fromEntries(pictureKeys.map((key) => [key, image(key, 'jpg')])),
  },
})

const workshop = buildQuotationPdfInput({
  business: {
    legalName: 'Al Itqan Carpentry',
    legalNameAr: 'نجارة الإتقان',
    locale: 'en',
    vatRegistered: true,
    trn: '100678901200003',
    phone: '+971 6 555 0177',
    phone2: null,
    email: 'orders@alitqan.example',
    addressLine: 'Industrial Area 2',
    city: null,
    emirate: 'sharjah',
    tradeLicenceNo: null,
    accent: 'brown',
    watermark: true,
    wholeAmounts: true,
    signatory: 'Hamad Al Dhaheri',
    footer: null,
  },
  quotation: quotation(
    [
      {
        area: null,
        title: 'Dining table, solid oak',
        details: '220 × 100 cm, natural oil finish',
        qty: '1',
        unit: 'piece',
        price: '6500',
      },
      {
        area: null,
        title: 'Dining chairs, upholstered',
        details: null,
        qty: '6',
        unit: 'piece',
        price: '500',
      },
    ],
    {
      number: 'Q-0012',
      revision: 1,
      draft: true,
      businessDate: '2026-10-16',
      validUntil: '2026-11-15',
      customerRef: null,
      site: null,
      greeting: null,
      intro:
        'Further to your visit to our workshop, please find our price for the dining set below.',
      terms: null,
      notes: 'Delivery within 3 weeks of the deposit.',
      wanted: null,
      stages: [
        { label: 'Deposit', due: 'With the order', percent: 40n },
        { label: 'Balance', due: 'On delivery', percent: 60n },
      ],
    },
  ),
  customer: {
    name: 'Sara Haddad',
    phone: '+971 52 555 0110',
    trn: null,
    addressLine: null,
    city: null,
    emirate: null,
  },
  businessImages: { logo: null, signature: null, stamp: null },
  images: {},
})

// Step 8's documents, through the same builders the API uses (M3 Step 8; the plan's definition of
// done): the fit-out company's tax invoice INV-0001 (gypsum partition 120 m² × 45.00, painting 300 m² ×
// 18.00, labour 5 days × 650.00 less 10 %: 13,725.00 + VAT 686.25 = 14,411.25; supplied three days
// before it was issued, with the LPO, the quotation it came from and a payment), its tax credit note
// CN-0001 for 100 m² of painting (1,800.00 + VAT 90.00), the workshop's final invoice after its deposit
// invoice (20,000.00 − 5,000.00 deposit = 15,000.00 + VAT 750.00 = 15,750.00), the designer's plain
// invoice (not VAT-registered: never the word "tax"; one line 500 less 100) and the factory's September
// statement (opening 0, invoiced 10,500.00, paid 8,000.00, closing 2,500.00).
const fitOutBusiness: PdfBusiness = {
  legalName: 'Modern Touch Interiors',
  legalNameAr: 'لمسة عصرية للديكور',
  locale: 'ar',
  vatRegistered: true,
  trn: '100345678900003',
  phone: '+971 4 555 0142',
  phone2: '+971 50 555 0199',
  email: 'hello@moderntouch.example',
  addressLine: 'Warehouse 7, Al Quoz Industrial 3',
  city: 'Dubai',
  emirate: 'dubai',
  tradeLicenceNo: 'DED-884210',
  accent: 'black',
  watermark: true,
  wholeAmounts: false,
  signatory: 'عبدالله الكعبي',
  footer:
    'Bank: Emirates Sample Bank\nAccount name: Modern Touch Interiors\nIBAN: AE00 0000 0000 0000 0000 000',
}
const fitOutImages = {
  logo: image('logo', 'png'),
  signature: image('signature', 'png'),
  stamp: image('stamp', 'png'),
}
const fitOutLogo = { logo: 'logo', signature: 'signature', stamp: 'stamp' }
const fitOutCustomer = {
  name: 'Gulf Horizon Properties LLC',
  phone: '+971 4 555 0300',
  trn: '100555666700003',
  addressLine: 'Office 1402, Marina Plaza',
  city: 'Dubai Marina',
  emirate: 'dubai' as const,
  showTrn: true,
}
const invoiceLine = (
  title: string,
  details: string | null,
  qty: string,
  unit: PdfInvoiceLine['unit'],
  price: string,
  discount: string,
): PdfInvoiceLine => {
  const subtotal = amount(times(qty, price))
  const net = fils(subtotal) - fils(discount)
  const vat = vat5(net)
  return {
    kind: 'item',
    area: null,
    title,
    details,
    note: null,
    qty,
    unit,
    unitPrice: price,
    subtotal,
    lineDiscount: discount,
    net: amount(net),
    vat: amount(vat),
    total: amount(net + vat),
    priceIncludesVat: false,
    vatCategory: 'standard',
    vatRate: '5',
    picture: null,
  }
}
/** A line as the description of a document the sales engine works out. */
interface EngineLine {
  readonly area?: string
  readonly title: string
  readonly details?: string
  readonly qty: string
  readonly unit: PdfInvoiceLine['unit']
  readonly price: string
  readonly vatCategory?: VatCategory
  readonly priceIncludesVat?: boolean
  readonly percentOff?: string
  readonly picture?: string
}
/** A tax invoice's amounts and lines from the sales engine, as an issued invoice stores them. */
function engineInvoice(
  lines: readonly EngineLine[],
  options: { readonly percentOff?: string; readonly wanted?: string },
): Pick<
  PdfInvoice,
  | 'vatRegistered'
  | 'subtotal'
  | 'discountTotal'
  | 'adjustment'
  | 'roundingDifference'
  | 'netTotal'
  | 'vatTotal'
  | 'total'
  | 'payable'
  | 'vatRates'
  | 'lines'
> {
  const input: SaleInput = {
    vatRegistered: true,
    discount: options.percentOff ? { percent: options.percentOff as Percent } : null,
    lines: lines.map((line) => ({
      kind: 'item',
      qty: line.qty as Quantity,
      unitPrice: line.price as Money,
      priceIncludesVat: line.priceIncludesVat ?? false,
      vatCategory: line.vatCategory ?? 'standard',
      discount: line.percentOff ? { percent: line.percentOff as Percent } : null,
    })),
  }
  const solved = options.wanted ? solveRoundAmount(input, options.wanted as Money, 'AED') : null
  const sale = solved ? solved.sale : computeSale(input, 'AED')
  const subtotal = sumDecimals(sale.lines.map((line) => line.subtotal))
  const ownDiscounts = sumDecimals(sale.lines.map((line) => line.discount))
  return {
    vatRegistered: true,
    subtotal,
    discountTotal: sumDecimals([ownDiscounts, sale.documentDiscount]),
    adjustment: sale.adjustment,
    roundingDifference: sale.roundingDifference,
    netTotal: sale.net,
    vatTotal: sale.vat,
    total: sale.total,
    payable: sale.payable,
    vatRates: sale.rates,
    lines: sale.lines.map((line, i) => ({
      kind: 'item',
      area: lines[i]!.area ?? null,
      title: lines[i]!.title,
      details: lines[i]!.details ?? null,
      note: null,
      qty: lines[i]!.qty,
      unit: lines[i]!.unit,
      unitPrice: lines[i]!.price,
      subtotal: line.subtotal,
      lineDiscount: line.discount,
      net: line.net,
      vat: line.vat,
      total: line.total,
      priceIncludesVat: line.priceIncludesVat,
      vatCategory: line.vatCategory,
      vatRate: line.vatRate,
      picture: lines[i]!.picture ?? null,
    })),
  }
}
const taxInvoice = buildInvoicePdfInput({
  business: fitOutBusiness,
  invoice: {
    kind: 'tax_invoice',
    number: 'INV-0001',
    draft: false,
    issueDate: '2026-10-18',
    supplyDate: '2026-10-15',
    dueDate: '2026-11-17',
    lpo: 'LPO-GH-2207',
    quotationNumber: 'Q-0001',
    orderNumber: null,
    currency: 'AED',
    vatRegistered: true,
    subtotal: '14050.00',
    discountTotal: '325.00',
    adjustment: '0',
    roundingDifference: '0',
    netTotal: '13725.00',
    vatTotal: '686.25',
    total: '14411.25',
    payable: '14411.25',
    vatRates: [{ vatCategory: 'standard', vatRate: '5', net: '13725.00', vat: '686.25' }],
    terms: 'Payment within 30 days of the invoice date.',
    notes: null,
    issuedAt: new Date('2026-10-18T10:15:00Z'),
    lines: [
      invoiceLine(
        'Gypsum partition',
        'Double board, 12.5 mm, with insulation',
        '120',
        'm2',
        '45',
        '0',
      ),
      invoiceLine('Painting', 'Two coats, emulsion, white', '300', 'm2', '18', '0'),
      invoiceLine('Labour', 'Site team of 4', '5', null, '650', '325.00'),
    ],
    payments: [
      { date: '2026-10-18', method: 'bank_transfer', reference: 'FT-2610-0412', amount: '5000.00' },
    ],
  },
  customer: fitOutCustomer,
  businessImages: fitOutLogo,
  images: fitOutImages,
})

const taxCreditNote = buildCreditNotePdfInput({
  business: fitOutBusiness,
  creditNote: {
    kind: 'tax_credit_note',
    number: 'CN-0001',
    draft: false,
    issueDate: '2026-10-25',
    invoiceNumber: 'INV-0001',
    invoiceDate: '2026-10-18',
    reason: 'price_changed',
    reasonText:
      '100 m² of painting and one day of labour were not done: the client painted the store room himself.',
    currency: 'AED',
    vatRegistered: true,
    netTotal: '2385.00',
    vatTotal: '119.25',
    total: '2504.25',
    vatRates: [{ vatCategory: 'standard', vatRate: '5', net: '2385.00', vat: '119.25' }],
    valueBefore: '13725.00',
    valueAfter: '11340.00',
    notes: null,
    issuedAt: new Date('2026-10-25T08:00:00Z'),
    lines: [
      {
        title: 'Painting',
        qty: '100',
        unit: 'm2',
        unitPrice: '18',
        priceIncludesVat: false,
        vatCategory: 'standard',
        vatRate: '5',
        net: '1800.00',
        vat: '90.00',
        total: '1890.00',
      },
      {
        // One of the invoice's 5 days of labour at 650.00 less 10 %.
        title: 'Labour',
        qty: '1',
        unit: null,
        unitPrice: '650',
        priceIncludesVat: false,
        vatCategory: 'standard',
        vatRate: '5',
        net: '585.00',
        vat: '29.25',
        total: '614.25',
      },
    ],
  },
  customer: fitOutCustomer,
  businessImages: fitOutLogo,
  images: fitOutImages,
})

const workshopBusiness: PdfBusiness = {
  legalName: 'Al Itqan Carpentry',
  legalNameAr: 'نجارة الإتقان',
  locale: 'en',
  vatRegistered: true,
  trn: '100678901200003',
  phone: '+971 6 555 0177',
  phone2: null,
  email: 'orders@alitqan.example',
  addressLine: 'Industrial Area 2',
  city: 'Sharjah',
  emirate: 'sharjah',
  tradeLicenceNo: 'SHJ-55102',
  accent: 'brown',
  watermark: true,
  wholeAmounts: true,
  signatory: 'Hamad Al Dhaheri',
  footer: 'Bank: Sharjah Sample Bank\nIBAN: AE00 0000 0000 0000 0000 111',
}
const workshopFinal = buildInvoicePdfInput({
  business: workshopBusiness,
  invoice: {
    kind: 'tax_invoice',
    number: 'INV-0008',
    draft: false,
    issueDate: '2026-10-18',
    supplyDate: '2026-10-18',
    dueDate: null,
    lpo: null,
    quotationNumber: null,
    orderNumber: '#1004',
    currency: 'AED',
    vatRegistered: true,
    subtotal: '15000.00',
    discountTotal: '0',
    adjustment: '0',
    roundingDifference: '0',
    netTotal: '15000.00',
    vatTotal: '750.00',
    total: '15750.00',
    payable: '15750.00',
    vatRates: [{ vatCategory: 'standard', vatRate: '5', net: '15000.00', vat: '750.00' }],
    terms: null,
    notes: 'Thank you for your order.',
    issuedAt: new Date('2026-10-18T12:00:00Z'),
    lines: [
      invoiceLine(
        'Built-in wardrobe, master bedroom',
        'Oak veneer, 4 doors, soft-close',
        '1',
        'piece',
        '12000',
        '0',
      ),
      invoiceLine('Kitchen island', 'Solid oak top, white lacquer base', '1', 'piece', '8000', '0'),
      {
        kind: 'deduction',
        area: null,
        title: 'Less deposit invoice INV-0005',
        details: null,
        note: null,
        qty: '-1',
        unit: null,
        unitPrice: '5000.00',
        subtotal: '-5000.00',
        lineDiscount: '0',
        net: '-5000.00',
        vat: '-250.00',
        total: '-5250.00',
        priceIncludesVat: false,
        vatCategory: 'standard',
        vatRate: '5',
        picture: null,
      },
    ],
    payments: [],
  },
  customer: {
    name: 'Faisal Al Mazrouei',
    phone: '+971 50 555 0188',
    trn: null,
    addressLine: 'Villa 3, Al Rahmaniya 1',
    city: 'Sharjah',
    emirate: 'sharjah',
    showTrn: true,
  },
  businessImages: { logo: null, signature: null, stamp: null },
  images: {},
})

const designerInvoice = buildInvoicePdfInput({
  business: {
    legalName: 'Noura Design Studio',
    legalNameAr: 'استوديو نورة للتصميم',
    locale: 'en',
    vatRegistered: false,
    trn: null,
    phone: '+971 56 555 0144',
    phone2: null,
    email: 'hello@nouradesign.example',
    addressLine: 'Al Khalidiya',
    city: 'Abu Dhabi',
    emirate: 'abu_dhabi',
    tradeLicenceNo: 'ADF-30987',
    accent: 'teal',
    watermark: false,
    wholeAmounts: true,
    signatory: 'Noura Al Ali',
    footer: 'Bank: Abu Dhabi Sample Bank\nIBAN: AE00 0000 0000 0000 0000 222',
  },
  invoice: {
    kind: 'invoice',
    number: 'INV-0003',
    draft: false,
    issueDate: '2026-10-18',
    supplyDate: '2026-10-12',
    dueDate: '2026-11-01',
    lpo: null,
    quotationNumber: null,
    orderNumber: null,
    currency: 'AED',
    vatRegistered: false,
    subtotal: '2500.00',
    discountTotal: '100.00',
    adjustment: '0',
    roundingDifference: '0',
    netTotal: '2400.00',
    vatTotal: '0',
    total: '2400.00',
    payable: '2400.00',
    vatRates: [],
    terms: null,
    notes: null,
    issuedAt: new Date('2026-10-18T09:00:00Z'),
    lines: [
      {
        ...invoiceLine(
          'Logo and brand identity',
          'Logo, colours and type, 3 rounds of changes',
          '1',
          null,
          '2000',
          '0',
        ),
        vat: '0',
        total: '2000.00',
        vatCategory: null,
        vatRate: null,
      },
      {
        ...invoiceLine('Business cards', 'Design only, both sides', '1', null, '500', '100.00'),
        vat: '0',
        total: '400.00',
        vatCategory: null,
        vatRate: null,
      },
    ],
    payments: [],
  },
  customer: {
    name: 'Bloom Florists LLC',
    phone: '+971 2 555 0161',
    trn: '100999888700003',
    addressLine: 'Shop 4, Al Khalidiya',
    city: 'Abu Dhabi',
    emirate: 'abu_dhabi',
    showTrn: true,
  },
  businessImages: { logo: null, signature: null, stamp: null },
  images: {},
})

// D-360's hard cases. The fit-out company's tower invoice: 5 %, zero-rated and exempt lines (each row
// says its own rate under its VAT), a price with VAT, amounts in the hundreds of millions, and a total
// rounded (each line's discount holds its share of the adjustment).
const mixedRatesInvoice = buildInvoicePdfInput({
  business: fitOutBusiness,
  invoice: {
    kind: 'tax_invoice',
    number: 'INV-0042',
    draft: false,
    issueDate: '2026-10-20',
    supplyDate: '2026-10-20',
    dueDate: '2026-11-19',
    lpo: 'LPO-GH-2311',
    quotationNumber: null,
    orderNumber: null,
    currency: 'AED',
    ...engineInvoice(
      [
        {
          title: 'واجهة زجاجية للبرج',
          details: 'Double glazing, aluminium frames, supply and fixing',
          qty: '12500.5',
          unit: 'm2',
          price: '18750',
          percentOff: '5',
        },
        {
          title: 'Joinery exported to Muscat',
          details: 'Zero-rated: exported with the customs papers',
          qty: '1',
          unit: 'piece',
          price: '2450000',
          vatCategory: 'zero_rated',
        },
        {
          title: 'إيجار سكني لموظفي الموقع',
          details: 'Exempt: residential rent, 12 months',
          qty: '12',
          unit: null,
          price: '104166.67',
          vatCategory: 'exempt',
        },
        {
          title: 'Site supervision',
          details: 'Price with VAT',
          qty: '3',
          unit: null,
          price: '10500',
          priceIncludesVat: true,
        },
        { title: 'Site survey', qty: '1', unit: null, price: '450' },
      ],
      { wanted: '237500000.00' },
    ),
    terms: 'Payment within 30 days of the invoice date.',
    notes: null,
    issuedAt: new Date('2026-10-20T08:00:00Z'),
    payments: [],
  },
  customer: fitOutCustomer,
  businessImages: fitOutLogo,
  images: fitOutImages,
})

// The workshop's prices with VAT: each row reads to its total, a document discount of 10 % and a total
// rounded inside each row's discount, in English.
const vatInclusiveInvoice = buildInvoicePdfInput({
  business: workshopBusiness,
  invoice: {
    kind: 'tax_invoice',
    number: 'INV-0009',
    draft: false,
    issueDate: '2026-10-22',
    supplyDate: '2026-10-22',
    dueDate: null,
    lpo: null,
    quotationNumber: null,
    orderNumber: null,
    currency: 'AED',
    ...engineInvoice(
      [
        { title: 'Dining chairs', qty: '3', unit: 'piece', price: '1050', priceIncludesVat: true },
        {
          title: 'Coffee table, solid oak',
          details: 'Natural oil finish',
          qty: '1',
          unit: 'piece',
          price: '2625',
          priceIncludesVat: true,
          percentOff: '5',
        },
        { title: 'Oak shelf', qty: '2.5', unit: 'm', price: '399', priceIncludesVat: true },
      ],
      { percentOff: '10', wanted: '5950.00' },
    ),
    terms: null,
    notes: 'Prices include VAT, as on our price list.',
    issuedAt: new Date('2026-10-22T07:30:00Z'),
    payments: [],
  },
  customer: {
    name: 'Faisal Al Mazrouei',
    phone: '+971 50 555 0188',
    trn: null,
    addressLine: 'Villa 3, Al Rahmaniya 1',
    city: 'Sharjah',
    emirate: 'sharjah',
    showTrn: true,
  },
  businessImages: { logo: null, signature: null, stamp: null },
  images: {},
})

// The villa's quotation as an invoice: areas and pictures over two pages, the head repeated.
const fitOutInvoice = buildInvoicePdfInput({
  business: fitOutBusiness,
  invoice: {
    kind: 'tax_invoice',
    number: 'INV-0015',
    draft: false,
    issueDate: '2026-10-25',
    supplyDate: '2026-10-25',
    dueDate: '2026-11-24',
    lpo: null,
    quotationNumber: 'Q-0007',
    orderNumber: null,
    currency: 'AED',
    ...engineInvoice(
      fitOutLines.map((line) => ({
        ...(line.area ? { area: line.area } : {}),
        title: line.title,
        ...(line.details ? { details: line.details } : {}),
        qty: line.qty,
        unit: line.unit,
        price: line.price,
        ...(line.picture ? { picture: line.picture } : {}),
      })),
      { wanted: '83900' },
    ),
    terms: 'Payment as per the stages of the quotation.',
    notes: null,
    issuedAt: new Date('2026-10-25T08:30:00Z'),
    payments: [],
  },
  customer: { ...fitOutCustomer, site: 'Villa 18, Al Barsha South' },
  businessImages: fitOutLogo,
  images: {
    ...fitOutImages,
    ...Object.fromEntries(pictureKeys.map((key) => [key, image(key, 'jpg')])),
  },
})

const factoryStatement = buildStatementPdfInput({
  business: {
    legalName: 'Al Naqaa Cleaning Products Factory',
    legalNameAr: 'مصنع النقاء لمواد التنظيف',
    locale: 'ar',
    vatRegistered: true,
    trn: '100567890100003',
    phone: '+971 6 555 0190',
    phone2: null,
    email: 'sales@alnaqaa.example',
    addressLine: 'المنطقة الصناعية 15',
    city: 'الشارقة',
    emirate: 'sharjah',
    tradeLicenceNo: 'SHJ-77120',
    accent: 'slate',
    watermark: false,
    wholeAmounts: false,
    signatory: null,
    footer: 'Bank: Sharjah Sample Bank\nIBAN: AE00 0000 0000 0000 0000 333',
  },
  statement: {
    from: '2026-09-01',
    to: '2026-09-30',
    issuedOn: '2026-10-01',
    currency: 'AED',
    opening: '0',
    invoiced: '10500.00',
    credited: '0',
    paid: '8000.00',
    closing: '2500.00',
    issuedAt: new Date('2026-10-01T06:00:00Z'),
    entries: [
      {
        date: '2026-09-05',
        kind: 'invoice',
        number: 'INV-0011',
        reference: null,
        charge: '5250.00',
        credit: '0',
        owed: '5250.00',
      },
      {
        date: '2026-09-14',
        kind: 'invoice',
        number: 'INV-0012',
        reference: null,
        charge: '3150.00',
        credit: '0',
        owed: '8400.00',
      },
      {
        date: '2026-09-22',
        kind: 'invoice',
        number: 'INV-0013',
        reference: null,
        charge: '2100.00',
        credit: '0',
        owed: '10500.00',
      },
      {
        date: '2026-09-28',
        kind: 'payment',
        number: null,
        reference: 'INV-0011',
        method: 'bank_transfer',
        charge: '0',
        credit: '5250.00',
        owed: '5250.00',
      },
      {
        date: '2026-09-28',
        kind: 'payment',
        number: null,
        reference: 'INV-0012',
        method: 'cheque',
        charge: '0',
        credit: '2750.00',
        owed: '2500.00',
      },
    ],
  },
  customer: {
    name: 'فندق اللؤلؤة',
    phone: '+971 4 555 0270',
    trn: '100234567800003',
    addressLine: 'شارع الشيخ زايد، مبنى 12',
    city: 'دبي',
    emirate: 'dubai',
  },
  businessImages: { logo: null, signature: null, stamp: null },
  images: {},
})

const write = (name: string, input: DocumentPdfInput) =>
  writeFileSync(join(samples, name), `${JSON.stringify(input, null, 2)}\n`)
write('fit-out-quotation.json', fitOut)
write('workshop-quotation.json', workshop)
write('tax-invoice.json', taxInvoice)
write('tax-credit-note.json', taxCreditNote)
write('workshop-final-invoice.json', workshopFinal)
write('designer-invoice.json', designerInvoice)
write('mixed-rates-invoice.json', mixedRatesInvoice)
write('vat-inclusive-invoice.json', vatInclusiveInvoice)
write('fit-out-invoice.json', fitOutInvoice)
write('factory-statement.json', factoryStatement)
console.log(`wrote the samples in ${samples}`)
