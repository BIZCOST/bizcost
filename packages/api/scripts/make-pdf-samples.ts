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
// scripts/samples/tax-invoice-sketch.json: the same letterhead as Step 8's «فاتورة ضريبية · Tax
// Invoice» (hand-made from the fit-out sample: due date, the buyer's TRN, VAT per line, a payment).
// Every business, customer and figure here is fictional (the demo personas), never a real customer.
// Amounts are worked out in fils (whole numbers), never in floating point.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildQuotationPdfInput, type PdfQuotation } from '../src/documents/pdf/build'
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

// Step 8's tax invoice on the same letterhead (a sketch until its builder exists): no pictures, VAT
// per line with one zero-rated, a payment beside the totals, the due date and the buyer's TRN.
const labels = fitOut.labels
const label = (key: string) => {
  const found = labels[key]
  if (!found) throw new Error(`documents.pdf.${key} is missing`)
  return found
}
const taxInvoice: DocumentPdfInput = {
  ...fitOut,
  kind: 'tax_invoice',
  locale: 'en',
  title: label('title.taxInvoice'),
  number: 'INV-0042',
  revision: null,
  dueDate: { en: '22 October 2026', ar: '22 أكتوبر 2026' },
  validUntil: null,
  validity: null,
  customerRef: 'LPO-7781/B',
  references: [{ label: { en: 'Quotation', ar: 'عرض السعر' }, value: 'Q-0007' }],
  opening: null,
  customer: {
    ...fitOut.customer,
    name: { text: 'Mr. Yousef Al Hammadi', dir: 'ltr' },
    trn: '100555666700003',
    address: { text: 'Villa 18, Al Barsha South, Dubai', dir: 'ltr' },
  },
  lines: [
    ...[0, 1, 6, 7].map((index, i) => ({
      ...fitOut.lines[index]!,
      no: i + 1,
      picture: null,
      vatRate: '5%',
    })),
    {
      no: 5,
      area: null,
      picture: null,
      title: { text: 'Export packing for the client’s shipment', dir: 'ltr' },
      details: { text: 'Crating and documents, goods exported', dir: 'ltr' },
      note: null,
      qty: '1',
      unit: 'pcs',
      unitPrice: '1,200.00',
      discount: null,
      vatRate: '0%',
      amount: '1,200.00',
    },
  ],
  table: { showPictures: false, showAreas: true, showDiscount: false, showVat: true },
  totals: [
    { label: label('totals.net'), amount: '32,439.00', strong: false },
    {
      label: { en: 'VAT 5% on 31,239.00', ar: 'ضريبة القيمة المضافة 5٪ على 31,239.00' },
      amount: '1,561.95',
      strong: false,
    },
    {
      label: { en: 'Zero-rated, on 1,200.00', ar: 'خاضع لنسبة الصفر، على 1,200.00' },
      amount: '0.00',
      strong: false,
    },
    { label: label('totals.total'), amount: '34,000.95', strong: false },
    { label: label('totals.paid'), amount: '-17,000.48', strong: false },
    { label: label('totals.balanceDue'), amount: '17,000.47', strong: true },
  ],
  stages: [],
  payments: [
    {
      date: { en: '10 October 2026', ar: '10 أكتوبر 2026' },
      method: { en: 'Bank transfer', ar: 'تحويل بنكي' },
      reference: 'FT-2610-8841',
      amount: '17,000.48',
    },
  ],
  terms: {
    text: 'Payment within 14 days of the invoice date.\nGoods remain our property until paid in full.',
    dir: 'ltr',
  },
  signature: {
    ...fitOut.signature,
    signatory: { text: 'Abdulla Al Kaabi', dir: 'ltr' },
    acceptance: false,
  },
}

const write = (name: string, input: DocumentPdfInput) =>
  writeFileSync(join(samples, name), `${JSON.stringify(input, null, 2)}\n`)
write('fit-out-quotation.json', fitOut)
write('workshop-quotation.json', workshop)
write('tax-invoice-sketch.json', taxInvoice)
console.log(`wrote the samples in ${samples}`)
