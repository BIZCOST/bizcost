import type {
  BusinessProfileDto,
  CreditNoteDto,
  CustomerStatementDto,
  DocumentPaymentsDto,
  DocumentPdfDto,
  InvoiceDto,
  InvoiceListDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { FIT_OUT, QuotationScope, QuotationsApi } from './quotations'
import { ok, type PurchasingApi, type Person } from './purchasing'

// Helpers of the invoices suites (ROADMAP.md M3 Step 8): the API as deployed (Invoices and Quotations
// are released since Release B, M3 Step 9), with the secret key for Storage (the issued PDFs). Every
// business, customer and figure is fictional.

/** The API of the invoices suites: the quotations suites' (as deployed). */
export class InvoicesApi extends QuotationsApi {}

/** The fictional seller's TRN, and a registered customer's. */
export const SELLER_TRN = '100345678900003'
export const BUYER_TRN = '100555666700003'

/** An invoice's typed line (Q21): no product. */
export function typed(description: string, qty: string, unitPrice: string, extra: object = {}) {
  return { id: newId(), productId: null, description, qty, unitPrice, ...extra }
}

/** An invoice's product line. */
export function product(productId: string, qty: string, unitPrice: string, extra: object = {}) {
  return { id: newId(), productId, qty, unitPrice, ...extra }
}

/** A business, its owner and a way to call as them, with the invoices helpers. */
export class InvoiceScope extends QuotationScope {
  static override async open(
    api: PurchasingApi,
    answers: SetupAnswers = FIT_OUT,
  ): Promise<InvoiceScope> {
    const { id, owner } = await api.business(answers)
    return new InvoiceScope(api, id, owner)
  }

  /** Gives the business what a tax invoice needs: its TRN and address (B16, C5). */
  async taxReady(extra: object = {}): Promise<void> {
    const profile = ok(await this.run<BusinessProfileDto>('business.profile'))
    ok(
      await this.run('business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: profile.legalNameAr,
        vatRegistered: profile.vatRegistered,
        trn: profile.vatRegistered ? SELLER_TRN : null,
        letterhead: {
          phone: '+971 4 555 0142',
          phone2: null,
          email: 'hello@moderntouch.example',
          addressLine: 'Warehouse 7, Al Quoz Industrial 3',
          city: 'Dubai',
          emirate: 'dubai',
          tradeLicenceNo: 'DED-884210',
          tradeLicenceAuthority: 'Dubai DET',
          ...extra,
        },
      }),
    )
  }

  /** A business customer with a TRN and an address (a registered recipient). */
  async buyer(input: object = {}) {
    return this.customer({
      kind: 'business',
      trn: BUYER_TRN,
      addressLine: 'Office 1402, Marina Plaza',
      city: 'Dubai Marina',
      emirate: 'dubai',
      ...input,
    })
  }

  /** A draft invoice from scratch. */
  async invoice(input: object, person: Person = this.owner): Promise<InvoiceDto> {
    return ok(await this.as<InvoiceDto>(person, 'invoice.create', { id: newId(), ...input }))
  }

  async getInvoice(id: string, person: Person = this.owner): Promise<InvoiceDto> {
    return ok(await this.as<InvoiceDto>(person, 'invoice.get', { id }))
  }

  async invoices(input: object = {}, person: Person = this.owner): Promise<InvoiceListDto> {
    return ok(await this.as<InvoiceListDto>(person, 'invoice.list', input))
  }

  issueRaw(invoice: { id: string; version: number }, person: Person = this.owner) {
    return this.as<InvoiceDto>(person, 'invoice.issue', {
      id: invoice.id,
      version: invoice.version,
    })
  }

  async issue(invoice: { id: string; version: number }, person: Person = this.owner) {
    return ok(await this.issueRaw(invoice, person))
  }

  /** A draft from scratch, issued. */
  async issued(input: object, person: Person = this.owner): Promise<InvoiceDto> {
    return this.issue(await this.invoice(input, person), person)
  }

  async fromQuotation(id: string, input: object = {}, person: Person = this.owner) {
    return ok(
      await this.as<InvoiceDto>(person, 'invoice.fromQuotation', { id, newId: newId(), ...input }),
    )
  }

  async fromOrder(orderId: string, input: object = {}, person: Person = this.owner) {
    return ok(
      await this.as<InvoiceDto>(person, 'invoice.fromOrder', {
        orderId,
        newId: newId(),
        ...input,
      }),
    )
  }

  async fromSale(saleId: string, person: Person = this.owner) {
    return ok(await this.as<InvoiceDto>(person, 'invoice.fromSale', { saleId, newId: newId() }))
  }

  async invoicePdf(id: string, person: Person = this.owner): Promise<DocumentPdfDto> {
    return ok(await this.as<DocumentPdfDto>(person, 'invoice.pdf', { id }))
  }

  /** A credit note's draft of `invoice`. */
  async creditDraft(invoiceId: string, input: object, person: Person = this.owner) {
    return ok(
      await this.as<CreditNoteDto>(person, 'creditNote.create', {
        id: newId(),
        invoiceId,
        eventDate: await this.today(),
        reason: 'price_changed',
        reasonText: 'Part of the work was not done',
        ...input,
      }),
    )
  }

  async issueCredit(note: { id: string; version: number }, person: Person = this.owner) {
    return ok(
      await this.as<CreditNoteDto>(person, 'creditNote.issue', {
        id: note.id,
        version: note.version,
      }),
    )
  }

  /** A credit note of `invoice`, issued. */
  async credit(invoiceId: string, input: object, person: Person = this.owner) {
    return this.issueCredit(await this.creditDraft(invoiceId, input, person), person)
  }

  async creditNotePdf(id: string, person: Person = this.owner): Promise<DocumentPdfDto> {
    return ok(await this.as<DocumentPdfDto>(person, 'creditNote.pdf', { id }))
  }

  /** A customer payment (or money given back) on an issued invoice. */
  async payInvoice(invoiceId: string, amount: string, extra: object = {}) {
    return ok(
      await this.as<DocumentPaymentsDto>(this.owner, 'customerPayment.record', {
        id: newId(),
        invoiceId,
        businessDate: await this.today(),
        method: 'bank_transfer',
        amount,
        ...extra,
      }),
    )
  }

  async statement(customerId: string, from: string, to: string, person: Person = this.owner) {
    return ok(
      await this.as<CustomerStatementDto>(person, 'customer.statement', { customerId, from, to }),
    )
  }
}
