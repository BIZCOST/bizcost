import { readFileSync } from 'node:fs'
import type {
  AttachmentUploadUrlDto,
  BooksDto,
  BusinessProfileDto,
  CustomerPickDto,
  DocumentImageUploadUrlDto,
  DocumentSettingsDto,
  QuotationDto,
  QuotationListDto,
} from '@bizcost/contracts'
import { newId, type DocumentAccent, type Emirate, type StandardUnit } from '@bizcost/domain'
import type { DemoApi } from './client'
import { addDays, daysBetween } from './days'

// The documents of the demo businesses (M3 Step 7, D-298; released with Release B, M3 Step 9): each
// one's letterhead (its phones, email, address and trade licence in the business profile; its accent
// colour, signatory, bank details and usual terms in Settings → Documents; its signature and stamp;
// the fit-out's generated logo) and a quotation or two in its own kind of work: the fit-out's rooms
// with their pictures, rounded and in stages, sent and accepted, and an office sent, revised and
// accepted; the designer's brand work, one accepted and one waiting; the workshop's furniture, sent.
// The café and the home baker get their letterhead only (their invoices and statements print on it).
// Everything is fictional (the sample PDFs' images, scripts/samples). Each part is written only when
// missing (a letterhead already filled in, a quotation already there with its reference, are kept),
// so `pnpm demo:seed` stays idempotent and keeps what the owner changed.

export interface DemoQuotationLine {
  readonly area?: string
  readonly description: string
  readonly details?: string
  readonly note?: string
  readonly qty: string
  readonly unit?: StandardUnit
  readonly unitPrice: string
  /** A sample picture (scripts/samples/images). */
  readonly picture?: string
}

export interface DemoQuotation {
  /** An existing demo customer's name (the costing seed adds them). */
  readonly customer: string
  /** The customer's reference: marks the demo's own quotation (written once). */
  readonly customerRef: string
  /** Its date, in days before the seed day (default: the seed day). */
  readonly daysAgo?: number
  readonly site?: string
  readonly lines: readonly DemoQuotationLine[]
  readonly roundTo?: string
  readonly stages?: readonly {
    readonly label?: string
    readonly due: string
    readonly percent: string
  }[]
  readonly send?: boolean
  /**
   * Once sent, revised into revision 2 (dated `daysAgo` before the seed day) with these lines, and
   * sent again; `accept` then answers the revision.
   */
  readonly revision?: { readonly daysAgo?: number; readonly lines: readonly DemoQuotationLine[] }
  readonly accept?: boolean
}

export interface DemoDocuments {
  readonly letterhead: {
    readonly phone: string
    readonly phone2?: string
    readonly email: string
    readonly addressLine: string
    readonly city?: string
    readonly emirate: Emirate
    readonly tradeLicenceNo: string
    readonly tradeLicenceAuthority: string
  }
  readonly settings: {
    readonly accent: DocumentAccent
    readonly signatory: string
    readonly footer: string
    /** A new quotation's terms (a business that does not quote has none). */
    readonly quotationTerms?: string
    readonly quotationValidDays: number
  }
  /** Sample images (scripts/samples/images) for the logo, the signature and the stamp. */
  readonly logo?: string
  readonly signature?: string
  readonly stamp?: string
  readonly quotations: readonly DemoQuotation[]
}

const SAMPLES = new URL('../scripts/samples/images/', import.meta.url)
const TYPE: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg' }

function sample(file: string): { bytes: Uint8Array; type: string } {
  const type = TYPE[file.split('.').pop() ?? '']
  if (!type) throw new Error(`not a sample image: ${file}`)
  return { bytes: new Uint8Array(readFileSync(new URL(file, SAMPLES))), type }
}

async function put(url: string, file: { bytes: Uint8Array; type: string }) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': file.type, 'x-upsert': 'false' },
    body: Buffer.from(file.bytes),
  })
  if (!response.ok) throw new Error(`upload: ${response.status}`)
}

/** What was written, for the summary. */
export interface DocumentsResult {
  readonly letterhead: boolean
  readonly quotations: number
}

export async function seedDocuments(
  api: DemoApi,
  token: string,
  businessId: string,
  spec: DemoDocuments,
): Promise<DocumentsResult> {
  let letterhead = false
  // The contact lines, when none is filled in yet.
  const profile = await api.query<BusinessProfileDto>('business.profile', token, businessId)
  const contacts = profile.letterhead
  // A city the address left out (the e-invoicing address has a street, a city and an emirate,
  // PINT-AE IBR-143-AE): filled in once, the rest kept as it is.
  if (contacts.addressLine && !contacts.city && spec.letterhead.city) {
    await api.mutate('business.updateProfile', token, businessId, {
      version: profile.version,
      legalName: profile.legalName,
      legalNameAr: profile.legalNameAr,
      vatRegistered: profile.vatRegistered,
      trn: profile.trn,
      letterhead: { ...contacts, city: spec.letterhead.city },
    })
    letterhead = true
  }
  if (!contacts.phone && !contacts.email && !contacts.addressLine) {
    await api.mutate('business.updateProfile', token, businessId, {
      version: profile.version,
      legalName: profile.legalName,
      legalNameAr: profile.legalNameAr,
      vatRegistered: profile.vatRegistered,
      trn: profile.trn,
      letterhead: {
        phone: spec.letterhead.phone,
        phone2: spec.letterhead.phone2 ?? null,
        email: spec.letterhead.email,
        addressLine: spec.letterhead.addressLine,
        city: spec.letterhead.city ?? null,
        emirate: spec.letterhead.emirate,
        tradeLicenceNo: spec.letterhead.tradeLicenceNo,
        tradeLicenceAuthority: spec.letterhead.tradeLicenceAuthority,
      },
    })
    letterhead = true
  }
  if (spec.logo && !profile.logoUrl) {
    const image = sample(spec.logo)
    const target = await api.mutate<{ path: string; uploadUrl: string }>(
      'business.logoUploadUrl',
      token,
      businessId,
      { contentType: image.type },
    )
    await put(target.uploadUrl, image)
    await api.mutate('business.setLogo', token, businessId, { path: target.path })
    letterhead = true
  }

  // Settings → Documents, when still as a new business has them (no one signs yet).
  let settings = await api.query<DocumentSettingsDto>('document.settings', token, businessId)
  if (settings.signatory === null) {
    settings = await api.mutate<DocumentSettingsDto>('document.updateSettings', token, businessId, {
      version: settings.version,
      footer: spec.settings.footer,
      quotationTerms: spec.settings.quotationTerms ?? null,
      quotationValidDays: spec.settings.quotationValidDays,
      accent: spec.settings.accent,
      watermark: true,
      wholeAmounts: false,
      signatory: spec.settings.signatory,
    })
    letterhead = true
  }
  for (const kind of ['signature', 'stamp'] as const) {
    const file = spec[kind]
    if (!file || settings[kind === 'signature' ? 'signatureUrl' : 'stampUrl']) continue
    const image = sample(file)
    const target = await api.mutate<DocumentImageUploadUrlDto>(
      'document.imageUploadUrl',
      token,
      businessId,
      { kind, contentType: image.type },
    )
    await put(target.uploadUrl, image)
    await api.mutate('document.setImage', token, businessId, { kind, path: target.path })
    letterhead = true
  }

  // The quotations, each once (found again by its reference).
  const { today } = await api.query<BooksDto>('books.get', token, businessId)
  let quotations = 0
  for (const demo of spec.quotations) {
    const found = await api.query<QuotationListDto>('quotation.list', token, businessId, {
      search: demo.customerRef,
    })
    if (found.items.some((item) => item.customerRef === demo.customerRef)) continue
    const picked = await api.query<CustomerPickDto>('customer.pick', token, businessId, {
      search: demo.customer,
    })
    const customer = picked.items.find((item) => item.name === demo.customer)
    if (!customer) throw new Error(`no demo customer ${demo.customer}`)
    const lines = demo.lines.map((line) => typedLine(newId(), line))
    let quote = await api.mutate<QuotationDto>('quotation.create', token, businessId, {
      id: newId(),
      customerId: customer.id,
      businessDate: addDays(today, -(demo.daysAgo ?? 0)),
      customerRef: demo.customerRef,
      site: demo.site ?? null,
      roundTo: demo.roundTo ?? null,
      lines,
      stages: (demo.stages ?? []).map((stage) => ({
        label: stage.label ?? null,
        due: stage.due,
        percent: stage.percent,
      })),
    })
    for (const [i, line] of demo.lines.entries()) {
      if (!line.picture) continue
      const image = sample(line.picture)
      const record = { entity: 'quotation_line' as const, entityId: lines[i]!.id }
      const target = await api.mutate<AttachmentUploadUrlDto>(
        'attachment.uploadUrl',
        token,
        businessId,
        { ...record, contentType: image.type },
      )
      await put(target.uploadUrl, image)
      await api.mutate('attachment.add', token, businessId, {
        ...record,
        path: target.path,
        fileName: line.picture,
      })
    }
    if (demo.send) {
      quote = await api.query<QuotationDto>('quotation.get', token, businessId, { id: quote.id })
      quote = await api.mutate<QuotationDto>('quotation.send', token, businessId, {
        id: quote.id,
        version: quote.version,
      })
      if (demo.revision) {
        // Revision 2: what the customer asked to change, its lines in place of the first's (each keeps
        // the id of the line in its place, so a picture copied with it stays).
        const draft = await api.mutate<QuotationDto>('quotation.revise', token, businessId, {
          id: quote.id,
          newId: newId(),
        })
        // Dated in the past, it is valid for the business's usual days from its own date (the revise
        // dated it today, valid that many days from today).
        const revisedOn = addDays(today, -(demo.revision.daysAgo ?? 0))
        const revised = await api.mutate<QuotationDto>('quotation.update', token, businessId, {
          id: draft.id,
          version: draft.version,
          customerId: draft.customerId,
          locationId: draft.locationId,
          businessDate: revisedOn,
          validUntil:
            draft.validUntil === null
              ? null
              : addDays(revisedOn, daysBetween(draft.businessDate, draft.validUntil)),
          customerRef: draft.customerRef,
          site: draft.site,
          discount: null,
          roundTo: null,
          greeting: draft.greeting,
          intro: draft.intro,
          notes: draft.notes,
          lines: demo.revision.lines.map((line, i) =>
            typedLine(draft.lines[i]?.id ?? newId(), line),
          ),
          stages: draft.stages.map((stage) => ({
            label: stage.label,
            due: stage.due,
            percent: stage.percent,
          })),
        })
        quote = await api.mutate<QuotationDto>('quotation.send', token, businessId, {
          id: revised.id,
          version: revised.version,
        })
      }
      if (demo.accept) {
        await api.mutate('quotation.accept', token, businessId, {
          id: quote.id,
          version: quote.version,
          note: null,
        })
      }
    }
    quotations += 1
  }
  return { letterhead, quotations }
}

/** A quotation's typed line (Q21) as the API takes it. */
function typedLine(id: string, line: DemoQuotationLine) {
  return {
    id,
    productId: null,
    area: line.area ?? null,
    description: line.description,
    details: line.details ?? null,
    note: line.note ?? null,
    qty: line.qty,
    unit: line.unit ?? null,
    unitPrice: line.unitPrice,
  }
}

/**
 * The fit-out company: the villa's rooms with pictures, rounded to a round total, in three stages
 * (30 / 40 / 30, each invoiced: FITOUT_INVOICES); a restaurant's ceiling and counter, waiting for its
 * answer; an office's partitions, revised once at the client's request (more glass, two more doors and
 * the glass film), accepted and billed in full.
 */
export const FITOUT_DOCUMENTS: DemoDocuments = {
  letterhead: {
    phone: '+971 4 555 0142',
    phone2: '+971 50 555 0199',
    email: 'hello@moderntouch.example',
    addressLine: 'مستودع 7، القوز الصناعية 3',
    city: 'دبي',
    emirate: 'dubai',
    // The number its stamp carries (scripts/samples/images/stamp.png).
    tradeLicenceNo: 'DED-884210',
    tradeLicenceAuthority: 'دائرة الاقتصاد والسياحة في دبي',
  },
  settings: {
    accent: 'black',
    signatory: 'عبدالله الكعبي',
    footer:
      'البنك: بنك الإمارات التجريبي\nاسم الحساب: لمسة عصرية للديكور\nIBAN: AE07 0331 2345 6789 0123 456',
    quotationTerms:
      'الأسعار تشمل التوريد والتركيب.\nمدة التنفيذ 6 إلى 8 أسابيع من تاريخ الدفعة الأولى.\nأي أعمال إضافية تُسعَّر في نسخة معدّلة من هذا العرض.',
    quotationValidDays: 30,
  },
  logo: 'logo.png',
  signature: 'signature.png',
  stamp: 'stamp.png',
  quotations: [
    {
      customer: 'سعيد بن حارب',
      customerRef: 'DEMO-FO-118',
      daysAgo: 20,
      site: 'فيلا 18، البرشاء جنوب',
      roundTo: '39500',
      stages: [
        { due: 'عند التوقيع', percent: '30' },
        { due: 'عند التوريد', percent: '40' },
        { due: 'بعد التسليم', percent: '30' },
      ],
      lines: [
        {
          area: 'المجلس',
          description: 'تكسية جدار بقشرة خشب',
          details: 'الخامة: MDF بقشرة جوز\nالتشطيب: ورنيش مطفي',
          qty: '18.5',
          unit: 'm2',
          unitPrice: '650',
          picture: 'line-1.jpg',
        },
        {
          area: 'المجلس',
          description: 'وحدة تلفزيون معلّقة',
          details: 'العرض 3.2 م مع إضاءة مخفية',
          note: 'يُضاف سعر الرخام بعد أن يختاره العميل',
          qty: '1',
          unitPrice: '7800',
          picture: 'line-2.jpg',
        },
        {
          area: 'غرفة الطعام',
          description: 'بوفيه من قشرة الجوز',
          details: 'الطول 2.4 م\nأدراج Hettich بإغلاق هادئ',
          qty: '1',
          unitPrice: '9600',
          picture: 'line-5.jpg',
        },
        {
          area: 'غرفة الطعام',
          description: 'خزانة عرض زجاجية',
          details: 'قشرة بلوط وزجاج شفاف\nإضاءة داخلية ورفّان زجاجيان',
          qty: '2',
          unitPrice: '4100',
          picture: 'line-4.jpg',
        },
      ],
      send: true,
      accept: true,
    },
    {
      customer: 'مطعم السنبوك',
      customerRef: 'DEMO-FO-124',
      daysAgo: 4,
      site: 'مطعم السنبوك، الخليج التجاري',
      stages: [
        { due: 'عند التوقيع', percent: '60' },
        { due: 'عند التسليم', percent: '40' },
      ],
      lines: [
        {
          area: 'الصالة',
          description: 'كسوة سقف بشرائح خشبية',
          qty: '64',
          unit: 'm2',
          unitPrice: '210',
        },
        {
          area: 'الصالة',
          description: 'كاونتر استقبال',
          details: 'سطح كوارتز أبيض',
          qty: '1',
          unitPrice: '12500',
        },
      ],
      send: true,
    },
    // M3 Step 8: an office billed in full once done (FITOUT_INVOICES, with a credit note); Release B:
    // revised once before it was accepted.
    {
      customer: 'شركة الأفق للاستشارات',
      customerRef: 'DEMO-FO-131',
      daysAgo: 12,
      site: 'مكاتب الأفق، برج الأعمال',
      lines: [
        {
          description: 'جدار جبسي مزدوج مع عزل صوتي',
          qty: '42',
          unit: 'm2',
          unitPrice: '120',
        },
        {
          description: 'قاطع زجاجي مقسّى 12 مم',
          details: 'بإطار ألمنيوم أسود',
          qty: '18',
          unit: 'm2',
          unitPrice: '680',
        },
        { description: 'باب خشبي للمكاتب', qty: '6', unit: 'piece', unitPrice: '1850' },
        {
          description: 'سقف مستعار مع إضاءة',
          qty: '120',
          unit: 'm2',
          unitPrice: '95',
        },
      ],
      send: true,
      revision: {
        daysAgo: 8,
        lines: [
          {
            description: 'جدار جبسي مزدوج مع عزل صوتي',
            qty: '42',
            unit: 'm2',
            unitPrice: '120',
          },
          {
            description: 'قاطع زجاجي مقسّى 12 مم',
            details: 'بإطار ألمنيوم أسود\nمساحة غرفة الاجتماعات أُضيفت بطلب العميل',
            qty: '24',
            unit: 'm2',
            unitPrice: '680',
          },
          { description: 'باب خشبي للمكاتب', qty: '8', unit: 'piece', unitPrice: '1850' },
          {
            description: 'سقف مستعار مع إضاءة',
            qty: '120',
            unit: 'm2',
            unitPrice: '95',
          },
          {
            description: 'ملصق زجاج مصنفر بشعار الشركة',
            qty: '24',
            unit: 'm2',
            unitPrice: '45',
          },
        ],
      },
      accept: true,
    },
  ],
}

/** The factory: its letterhead for the tax invoices of its orders (it sends no quotations here). */
export const FACTORY_DOCUMENTS: DemoDocuments = {
  letterhead: {
    phone: '+971 6 555 0190',
    email: 'sales@alnaqaa.example',
    addressLine: 'المنطقة الصناعية 15',
    city: 'الشارقة',
    emirate: 'sharjah',
    tradeLicenceNo: 'SHJ-77120',
    tradeLicenceAuthority: 'دائرة التنمية الاقتصادية بالشارقة',
  },
  settings: {
    accent: 'slate',
    signatory: 'سلطان المزروعي',
    footer:
      'البنك: بنك الشارقة التجريبي\nاسم الحساب: مصنع النقاء لمواد التنظيف\nIBAN: AE33 0410 0000 1234 5678 333',
    quotationTerms: 'الأسعار تشمل التوصيل داخل الشارقة ودبي.',
    quotationValidDays: 15,
  },
  quotations: [],
}

/**
 * The designer: her letterhead for the quotes and plain invoices of her work (no logo, no VAT): a
 * spa's menu and signage, accepted, and three months of a realty firm's social media, waiting.
 */
export const DESIGNER_DOCUMENTS: DemoDocuments = {
  letterhead: {
    phone: '+971 56 555 0144',
    email: 'hello@nouradesign.example',
    addressLine: 'Al Khalidiya',
    city: 'Abu Dhabi',
    emirate: 'abu_dhabi',
    tradeLicenceNo: 'ADF-30987',
    tradeLicenceAuthority: 'Abu Dhabi Department of Economic Development',
  },
  settings: {
    accent: 'teal',
    signatory: 'Noura Al Ali',
    footer: 'Bank: Abu Dhabi Sample Bank\nIBAN: AE00 0000 0000 0000 0000 222',
    quotationTerms: 'Two rounds of changes are included.\nFinal files after the last payment.',
    quotationValidDays: 14,
  },
  quotations: [
    {
      customer: 'Sahara Spa',
      customerRef: 'DEMO-ND-207',
      daysAgo: 6,
      site: 'Jumeirah branch',
      stages: [
        { due: 'On signing', percent: '50' },
        { due: 'With the final files', percent: '50' },
      ],
      lines: [
        {
          description: 'Treatment menu design',
          details: '8 pages, English and Arabic\nPrint-ready files',
          qty: '1',
          unitPrice: '2400',
        },
        {
          description: 'Signage set',
          details: 'Reception, treatment rooms and directions',
          qty: '1',
          unitPrice: '1800',
        },
        { description: 'Print supervision', qty: '3', unit: 'h', unitPrice: '250' },
      ],
      send: true,
      accept: true,
    },
    {
      customer: 'Gulf Realty',
      customerRef: 'DEMO-ND-211',
      daysAgo: 2,
      stages: [
        { due: 'Month 1', percent: '40' },
        { due: 'Month 2', percent: '30' },
        { due: 'Month 3', percent: '30' },
      ],
      lines: [
        {
          description: 'Social media post design',
          details: '12 posts a month for 3 months',
          qty: '36',
          unitPrice: '150',
        },
        { description: 'Monthly content plan', qty: '3', unitPrice: '400' },
      ],
      send: true,
    },
  ],
}

/** The café: its letterhead for the tax invoices it sends to companies (catering), no quotations. */
export const CAFE_DOCUMENTS: DemoDocuments = {
  letterhead: {
    phone: '+971 4 555 0168',
    email: 'hello@beancorner.example',
    addressLine: 'محل 4، شارع الوصل، جميرا 1',
    city: 'دبي',
    emirate: 'dubai',
    tradeLicenceNo: 'DED-662190',
    tradeLicenceAuthority: 'دائرة الاقتصاد والسياحة في دبي',
  },
  settings: {
    accent: 'green',
    signatory: 'خالد المنصوري',
    footer:
      'البنك: بنك الإمارات التجريبي\nاسم الحساب: مقهى ركن البن\nIBAN: AE21 0330 0000 1234 5678 444',
    quotationValidDays: 14,
  },
  // Its own stamp (its names and licence; scripts/samples/images).
  stamp: 'stamp-cafe.png',
  quotations: [],
}

/**
 * The home baker: her letterhead for the statements of the customers she sells to on credit (Release
 * B, B10): her phone, email and area, and the bank details for a transfer. No quotations or invoices.
 */
export const BAKER_DOCUMENTS: DemoDocuments = {
  letterhead: {
    phone: '+971 50 555 0131',
    email: 'sara.sweets@sweets.example',
    addressLine: 'فيلا 22، المزهر 1',
    city: 'دبي',
    emirate: 'dubai',
    tradeLicenceNo: 'DED-HB-44210',
    tradeLicenceAuthority: 'دائرة الاقتصاد والسياحة في دبي',
  },
  settings: {
    accent: 'maroon',
    signatory: 'سارة الحمادي',
    footer: 'التحويل البنكي: سارة الحمادي\nIBAN: AE60 0350 0000 0098 7654 321',
    quotationValidDays: 14,
  },
  quotations: [],
}

/**
 * The carpentry workshop: furniture made to order, no logo (its names carry the letterhead). Its
 * owner writes in Arabic, so its address, bank lines and terms are typed in Arabic, as the fit-out's
 * and the factory's (Release B second review).
 */
export const WORKSHOP_DOCUMENTS: DemoDocuments = {
  letterhead: {
    phone: '+971 6 555 0177',
    email: 'orders@alitqan.example',
    addressLine: 'المنطقة الصناعية 2، شارع 14',
    city: 'الشارقة',
    emirate: 'sharjah',
    tradeLicenceNo: 'SHJ-55120',
    tradeLicenceAuthority: 'دائرة التنمية الاقتصادية بالشارقة',
  },
  settings: {
    accent: 'brown',
    signatory: 'حمد الظاهري',
    footer:
      'البنك: البنك الوطني التجريبي\nاسم الحساب: نجارة الإتقان\nIBAN: AE45 0260 0010 1234 5678 901',
    quotationTerms: 'الأسعار تشمل التوصيل داخل الشارقة.\nيبدأ العمل بعد استلام الدفعة المقدمة.',
    quotationValidDays: 14,
  },
  signature: 'signature.png',
  // Its own stamp (its names and licence), as the fit-out's stamp carries its own.
  stamp: 'stamp-workshop.png',
  quotations: [
    {
      customer: 'مدرسة النور الخاصة',
      customerRef: 'DEMO-WS-3012',
      site: 'مكتبة المدرسة',
      stages: [
        { due: 'دفعة مقدمة', percent: '40' },
        { due: 'عند التسليم', percent: '60' },
      ],
      lines: [
        {
          description: 'رفوف كتب من خشب الزان',
          details: 'الارتفاع 2.2 م\nستة أرفف',
          qty: '12',
          unit: 'piece',
          unitPrice: '1450',
          picture: 'line-3.jpg',
        },
        {
          description: 'طاولة قراءة مستديرة',
          qty: '4',
          unit: 'piece',
          unitPrice: '2300',
          picture: 'line-15.jpg',
        },
      ],
      send: true,
    },
  ],
}
