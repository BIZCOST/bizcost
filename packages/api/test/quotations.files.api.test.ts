import type {
  AttachmentDto,
  AttachmentUploadUrlDto,
  BusinessProfileDto,
  DocumentImageUploadUrlDto,
  DocumentSettingsDto,
  QuotationDto,
} from '@bizcost/contracts'
import { crc32, deflateSync } from 'node:zlib'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeObjects, uploadObject } from '../src/admin/storage-admin'
import { pdfFullText } from '../src/documents/pdf/text-layer'
import { PNG, uploadTo } from './hardening/fixture'
import { SECRET_KEY, testConfig } from './helpers'
import { codeOf, ok } from './purchasing'
import { QuotationScope, QuotationsApi, quoteTyped } from './quotations'
import { CAFE } from './sales'
import { BAKER } from './settings'

// A quotation's files and its PDF's images (ROADMAP.md M3 Step 7; the owner's document requests of
// 2026-10-16; D-085's upload registry): a line's picture (an image, only while the quotation is a
// draft, copied with a revision), the signature and the stamp of Settings → Documents (images checked
// like the logo), the business's contact lines (only with Quotations or Invoices served), each printed
// from the business's own Storage objects; the PDFs' rate limit; and who may do what. Fictional data.

let api: QuotationsApi

beforeAll(() => {
  api = new QuotationsApi()
})

afterAll(async () => {
  await api.close()
})

const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>')

async function pictured(scope: QuotationScope, lineId: string, bytes = PNG, type = 'image/png') {
  const url = ok(
    await scope.run<AttachmentUploadUrlDto>('attachment.uploadUrl', {
      entity: 'quotation_line',
      entityId: lineId,
      contentType: type,
    }),
  )
  const put = await uploadTo(url.uploadUrl, bytes, type)
  expect(put.ok).toBe(true)
  return scope.run<{ data: AttachmentDto }>('attachment.add', {
    entity: 'quotation_line',
    entityId: lineId,
    path: url.path,
    fileName: 'cabinet.png',
  })
}

async function documentImage(scope: QuotationScope, kind: 'signature' | 'stamp', bytes = PNG) {
  const url = ok(
    await scope.run<DocumentImageUploadUrlDto>('document.imageUploadUrl', {
      kind,
      contentType: 'image/png',
    }),
  )
  expect((await uploadTo(url.uploadUrl, bytes, 'image/png')).ok).toBe(true)
  return scope.run<DocumentSettingsDto>('document.setImage', { kind, path: url.path })
}

const pdfBytes = async (scope: QuotationScope, id: string) =>
  new Uint8Array(Buffer.from((await scope.pdf(id)).base64, 'base64'))

const imagesIn = (pdf: Uint8Array) =>
  (
    Buffer.from(pdf)
      .toString('latin1')
      .match(/\/Subtype\s*\/Image/g) ?? []
  ).length

/** An opaque 64 × 48 RGB PNG of one colour, or (`idat`) one whose image data is `idat`. */
function rgbPng(colour: number, idat?: Buffer): Buffer<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(48, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.alloc(1 + 64 * 3, colour)
  row[0] = 0
  const data = idat ?? deflateSync(Buffer.concat(Array.from({ length: 48 }, () => row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', data),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A PNG whose structure is whole (its chunks and their checksums right, an end) over image data that
 * does not decode: what a header check alone lets through (D-295).
 */
const brokenPng = () => rgbPng(0, Buffer.alloc(200, 0x5a))

describe('images a PDF prints are decoded before they are kept (D-295)', () => {
  it('a line picture, a signature or a logo that does not decode is refused at upload', async () => {
    const scope = await QuotationScope.open(api)
    const customer = await scope.customer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Cabinet', '1', '1000')],
    })
    expect(codeOf(await pictured(scope, quote.lines[0]!.id, brokenPng()))).toBe(
      'attachment_invalid',
    )
    expect(codeOf(await documentImage(scope, 'signature', brokenPng()))).toBe('file_invalid')
    const upload = ok(
      await scope.run<{ path: string; uploadUrl: string }>('business.logoUploadUrl', {
        contentType: 'image/png',
      }),
    )
    expect((await uploadTo(upload.uploadUrl, brokenPng(), 'image/png')).ok).toBe(true)
    expect(codeOf(await scope.run('business.setLogo', { path: upload.path }))).toBe('file_invalid')
  })

  it('a stored picture that no longer decodes is left out: the PDF still prints, without it', async () => {
    const scope = await QuotationScope.open(api)
    const customer = await scope.customer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Cabinet', '1', '1000'), quoteTyped('Shelf', '2', '150')],
    })
    ok(await pictured(scope, quote.lines[0]!.id, rgbPng(0x40)))
    ok(await pictured(scope, quote.lines[1]!.id, rgbPng(0xc0)))
    const withPictures = await scope.getQuote(quote.id)
    expect(imagesIn(await pdfBytes(scope, quote.id))).toBe(2)
    // The first picture's object turns into bytes that do not decode (as an upload before this check
    // could have stored): the PDF prints with the other picture, never an error.
    const path = decodeURIComponent(new URL(withPictures.lines[0]!.picture!.url!).pathname).replace(
      /^.*\/business-files\//,
      '',
    )
    const admin = { ...testConfig, supabaseSecretKey: SECRET_KEY }
    await removeObjects(admin, [path])
    // Storage takes a file only at a path with an open upload: the test opens it again for a moment.
    await api.admin`update app.file_uploads set status = 'issued', expires_at = now() + interval '1 hour'
                     where path = ${path}`
    await uploadObject(admin, path, brokenPng(), 'image/png')
    await api.admin`update app.file_uploads set status = 'used' where path = ${path}`
    const pdf = await pdfBytes(scope, quote.id)
    expect(imagesIn(pdf)).toBe(1)
    expect(await pdfFullText(pdf)).toContain('Shelf')
  })
})

describe('line pictures', () => {
  it('an image on a draft line prints in the PDF, is copied with a revision, and is frozen once sent', async () => {
    const scope = await QuotationScope.open(api)
    const customer = await scope.customer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Cabinet', '1', '1000'), quoteTyped('Shelf', '2', '150')],
    })
    const line = quote.lines[0]!
    const pdfType = await scope.run('attachment.uploadUrl', {
      entity: 'quotation_line',
      entityId: line.id,
      contentType: 'application/pdf',
    })
    expect(codeOf(pdfType)).toBe('validation')
    const html = await pictured(scope, line.id, HTML)
    expect(codeOf(html)).toBe('attachment_invalid')

    ok(await pictured(scope, line.id))
    const second = await scope.run('attachment.uploadUrl', {
      entity: 'quotation_line',
      entityId: line.id,
      contentType: 'image/png',
    })
    expect(codeOf(second)).toBe('validation')
    const withPicture = await scope.getQuote(quote.id)
    expect(withPicture.lines[0]!.picture).toMatchObject({ fileName: 'cabinet.png' })
    expect(withPicture.lines[0]!.picture?.url).toMatch(/^https?:\/\//)
    expect(withPicture.lines[1]!.picture).toBeNull()
    expect(imagesIn(await pdfBytes(scope, quote.id))).toBeGreaterThanOrEqual(1)

    const sent = await scope.send(withPicture)
    const frozen = await scope.run('attachment.uploadUrl', {
      entity: 'quotation_line',
      entityId: sent.lines[1]!.id,
      contentType: 'image/png',
    })
    expect(codeOf(frozen)).toBe('quotation_frozen')
    const removed = await scope.run('attachment.remove', { id: sent.lines[0]!.picture!.id })
    expect(codeOf(removed)).toBe('quotation_frozen')

    const revision = await scope.revise(sent)
    expect(revision.lines[0]!.picture).not.toBeNull()
    expect(revision.lines[0]!.picture!.id).not.toBe(sent.lines[0]!.picture!.id)
    ok(await scope.run('attachment.remove', { id: revision.lines[0]!.picture!.id }))
    expect((await scope.getQuote(sent.id)).lines[0]!.picture).not.toBeNull()
  })
})

describe('the signature, the stamp and the contact lines', () => {
  it('prints the business’s own signature, stamp and contacts; refuses what is not an image', async () => {
    const scope = await QuotationScope.open(api)
    const customer = await scope.customer({ name: 'Sara Haddad' })
    expect(codeOf(await documentImage(scope, 'signature', HTML))).toBe('file_invalid')
    ok(await documentImage(scope, 'signature'))
    const settings = ok(await documentImage(scope, 'stamp'))
    expect(settings.signatureUrl).toMatch(/^https?:\/\//)
    expect(settings.stampUrl).toMatch(/^https?:\/\//)
    ok(await scope.updateDocumentSettings({ signatory: 'Hamad Al Dhaheri' }))

    const profile = ok(await scope.run<BusinessProfileDto>('business.profile'))
    ok(
      await scope.run('business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: profile.legalNameAr,
        vatRegistered: profile.vatRegistered,
        trn: profile.vatRegistered ? '100123456700003' : null,
        letterhead: {
          phone: '+971 6 555 0177',
          phone2: null,
          email: 'orders@alitqan.example',
          addressLine: 'Industrial Area 2',
          city: null,
          emirate: 'sharjah',
          tradeLicenceNo: 'SHJ-55120',
          tradeLicenceAuthority: 'Sharjah Economic Development Department',
        },
      }),
    )
    const saved = ok(await scope.run<BusinessProfileDto>('business.profile'))
    expect(saved.letterhead).toMatchObject({ email: 'orders@alitqan.example', emirate: 'sharjah' })

    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Dining table', '1', '6500')],
    })
    const pdf = await pdfBytes(scope, quote.id)
    expect(imagesIn(pdf)).toBeGreaterThanOrEqual(2)
    const text = await pdfFullText(pdf)
    expect(text).toContain('+971 6 555 0177')
    expect(text).toContain('orders@alitqan.example')
    expect(text).toContain('Industrial Area 2, Sharjah')
    expect(text).toContain('SHJ-55120')
    expect(text).toContain('Hamad Al Dhaheri')

    ok(await scope.run('document.removeImage', { kind: 'stamp' }))
    expect(ok(await scope.run<DocumentSettingsDto>('document.settings')).stampUrl).toBeNull()
  })

  it('the contact lines and Settings → Documents wait for a document the business prints', async () => {
    // A café selling through its POS (Customers and Payments off): it prints no document.
    const cafe = await QuotationScope.open(api, { ...CAFE, vat: 'no' })
    const profile = ok(await cafe.run<BusinessProfileDto>('business.profile'))
    const refused = await cafe.run('business.updateProfile', {
      version: profile.version,
      legalName: profile.legalName,
      legalNameAr: profile.legalNameAr,
      vatRegistered: profile.vatRegistered,
      trn: profile.trn,
      letterhead: { phone: '050 000 0000' },
    })
    expect(codeOf(refused)).toBe('module_disabled')
    expect(codeOf(await cafe.run('document.settings'))).toBe('module_disabled')
    expect(codeOf(await cafe.run('quotation.list'))).toBe('module_disabled')
    // Without the letterhead, the profile saves as it always did.
    ok(
      await cafe.run('business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: profile.legalNameAr,
        vatRegistered: profile.vatRegistered,
        trn: profile.trn,
      }),
    )
  })

  it('Release B: an orders-only business prints its customers’ statements, so its letterhead is served (B10)', async () => {
    // The home baker: Orders, Customers and Payments on, no Quotations or Invoices.
    const baker = await QuotationScope.open(api, BAKER)
    expect(codeOf(await baker.run('quotation.list'))).toBe('module_disabled')
    expect(codeOf(await baker.run('invoice.list'))).toBe('module_disabled')
    const profile = ok(await baker.run<BusinessProfileDto>('business.profile'))
    const saved = ok(
      await baker.run<{ profile: BusinessProfileDto }>('business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: profile.legalNameAr,
        vatRegistered: profile.vatRegistered,
        trn: null,
        letterhead: { phone: '050 000 0000', email: 'hello@sweets.example' },
      }),
    )
    expect(saved.profile.letterhead).toMatchObject({
      phone: '050 000 0000',
      email: 'hello@sweets.example',
    })
    const settings = ok(await baker.run<DocumentSettingsDto>('document.settings'))
    ok(
      await baker.run('document.updateSettings', {
        version: settings.version,
        footer: 'IBAN AE00 0000 0000 0000 0000 111',
        quotationTerms: settings.quotationTerms,
        quotationValidDays: settings.quotationValidDays,
        accent: 'maroon',
        watermark: true,
        wholeAmounts: false,
        signatory: null,
      }),
    )
    // Its logo prints on the statements: checked as a PDF decodes it (D-295).
    const upload = ok(
      await baker.run<{ path: string; uploadUrl: string }>('business.logoUploadUrl', {
        contentType: 'image/png',
      }),
    )
    expect((await uploadTo(upload.uploadUrl, brokenPng(), 'image/png')).ok).toBe(true)
    expect(codeOf(await baker.run('business.setLogo', { path: upload.path }))).toBe('file_invalid')
  })
})

describe('who may do what', () => {
  it('Sales prepare and decide, the Accountant only sees, the Employee nothing; documents are the Admin’s', async () => {
    const scope = await QuotationScope.open(api)
    const customer = await scope.customer()
    const business = { id: scope.id, owner: scope.owner }
    const sales = await api.member(business, 'sales')
    const accountant = await api.member(business, 'accountant')
    const employee = await api.member(business, 'employee')
    const admin = await api.member(business, 'admin')

    const quote = await scope.quote(
      { customerId: customer.id, lines: [quoteTyped('A', '1', '1')] },
      sales,
    )
    const sent = await scope.send(quote, sales)
    expect((await scope.accept(sent, null, sales)).status).toBe('accepted')
    ok(await scope.as<QuotationDto>(accountant, 'quotation.get', { id: quote.id }))
    expect(
      codeOf(
        await scope.as(accountant, 'quotation.create', {
          id: newId(),
          customerId: customer.id,
          businessDate: await scope.today(),
        }),
      ),
    ).toBe('forbidden')
    expect(codeOf(await scope.as(employee, 'quotation.list'))).toBe('forbidden')
    expect(codeOf(await scope.as(sales, 'document.settings'))).toBe('forbidden')
    ok(await scope.as(admin, 'document.settings'))
  })
})

describe('the PDFs’ rate limit', () => {
  it('stops a member after 20 PDFs in a minute', async () => {
    const scope = await QuotationScope.open(api)
    const customer = await scope.customer()
    const quote = await scope.quote({ customerId: customer.id, lines: [quoteTyped('A', '1', '1')] })
    for (let i = 0; i < 20; i++) await scope.pdf(quote.id)
    expect(codeOf(await scope.run('quotation.pdf', { id: quote.id }))).toBe('rate_limited')
  }, 120_000)
})
