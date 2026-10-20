import type {
  DocumentPdfDto,
  DocumentSettingsDto,
  QuotationDto,
  QuotationHistoryDto,
  QuotationListDto,
  QuotationOrderDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { WORKSHOP } from './settings'
import { OrderScope, OrdersApi } from './orders'
import { ok, type PurchasingApi, type Person } from './purchasing'

// Helpers of the quotations suites (ROADMAP.md M3 Step 7): the API as deployed (Quotations is
// released since Release B, M3 Step 9), with the secret key for Storage (line pictures, signatures,
// stamps). Quotations, orders and customers are made through the API. Every business and customer is
// fictional.

/** The API of the quotations suites: the orders suites' (as deployed). */
export class QuotationsApi extends OrdersApi {}

/**
 * A workshop that quotes custom work: VAT, a team, branches, quotes and orders (Smart Setup turns
 * Quotations and Orders on), as the hardening fixture's.
 */
export const FIT_OUT: SetupAnswers = WORKSHOP

/** A designer alone, not registered for VAT, quoting services. */
export const DESIGNER: SetupAnswers = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
}

/** A quotation's line: a product of the business. */
export function quoteItem(productId: string, qty: string, unitPrice: string, extra: object = {}) {
  return { id: newId(), productId, qty, unitPrice, ...extra }
}

/** A quotation's typed line (Q21): no product. */
export function quoteTyped(
  description: string,
  qty: string,
  unitPrice: string,
  extra: object = {},
) {
  return { id: newId(), productId: null, description, qty, unitPrice, ...extra }
}

/** A business, its owner and a way to call as them, with the quotations helpers. */
export class QuotationScope extends OrderScope {
  static override async open(
    api: PurchasingApi,
    answers: SetupAnswers = FIT_OUT,
  ): Promise<QuotationScope> {
    const { id, owner } = await api.business(answers)
    return new QuotationScope(api, id, owner)
  }

  /** A draft quotation for `customerId`, dated today. */
  async quote(input: object, person: Person = this.owner): Promise<QuotationDto> {
    return ok(
      await this.as<QuotationDto>(person, 'quotation.create', {
        id: newId(),
        businessDate: await this.today(),
        ...input,
      }),
    )
  }

  async getQuote(id: string, person: Person = this.owner): Promise<QuotationDto> {
    return ok(await this.as<QuotationDto>(person, 'quotation.get', { id }))
  }

  async quotes(input: object = {}, person: Person = this.owner): Promise<QuotationListDto> {
    return ok(await this.as<QuotationListDto>(person, 'quotation.list', input))
  }

  async send(quote: QuotationDto, person: Person = this.owner): Promise<QuotationDto> {
    return ok(
      await this.as<QuotationDto>(person, 'quotation.send', {
        id: quote.id,
        version: quote.version,
      }),
    )
  }

  async accept(quote: QuotationDto, note: string | null = null, person: Person = this.owner) {
    return ok(
      await this.as<QuotationDto>(person, 'quotation.accept', {
        id: quote.id,
        version: quote.version,
        note,
      }),
    )
  }

  async decline(quote: QuotationDto, person: Person = this.owner) {
    return ok(
      await this.as<QuotationDto>(person, 'quotation.decline', {
        id: quote.id,
        version: quote.version,
      }),
    )
  }

  async revise(quote: QuotationDto, person: Person = this.owner): Promise<QuotationDto> {
    return ok(
      await this.as<QuotationDto>(person, 'quotation.revise', { id: quote.id, newId: newId() }),
    )
  }

  async toOrder(quote: QuotationDto, person: Person = this.owner): Promise<QuotationOrderDto> {
    return ok(
      await this.as<QuotationOrderDto>(person, 'quotation.toOrder', {
        id: quote.id,
        orderId: newId(),
      }),
    )
  }

  async history(id: string, person: Person = this.owner): Promise<QuotationHistoryDto> {
    return ok(await this.as<QuotationHistoryDto>(person, 'quotation.history', { id }))
  }

  async pdf(id: string, person: Person = this.owner): Promise<DocumentPdfDto> {
    return ok(await this.as<DocumentPdfDto>(person, 'quotation.pdf', { id }))
  }

  async documentSettings(person: Person = this.owner): Promise<DocumentSettingsDto> {
    return ok(await this.as<DocumentSettingsDto>(person, 'document.settings'))
  }

  /** The whole Settings → Documents form, from what it reads now and `change`. */
  async updateDocumentSettings(change: object, person: Person = this.owner) {
    const current = await this.documentSettings(person)
    return this.as<DocumentSettingsDto>(person, 'document.updateSettings', {
      version: current.version,
      series: [],
      footer: current.footer,
      quotationTerms: current.quotationTerms,
      quotationValidDays: current.quotationValidDays,
      accent: current.accent,
      watermark: current.watermark,
      wholeAmounts: current.wholeAmounts,
      signatory: current.signatory,
      ...change,
    })
  }
}
