import type {
  CustomerDto,
  DocumentPaymentsDto,
  OrderDto,
  OrderListDto,
  ReceivableListDto,
  SaleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { handlerFor, SECRET_KEY } from './helpers'
import { tag } from './product-costs'
import { ProfitScope } from './profit'
import { ok, PurchasingApi, type Person } from './purchasing'

// Helpers of the orders tests (ROADMAP.md M3 Step 5): Customers, Payments and Orders are planned until
// Release A (Step 6), so the API runs with the dev-only preview of them and of Sales and Reports
// (D-125), as a local server does. Customers, orders, payments and refunds are made through the API.

/** The modules the orders suites preview (D-125). */
export const ORDERS_PREVIEW = ['customers', 'sales', 'payments', 'reports', 'orders'] as const

export class OrdersApi extends PurchasingApi {
  override readonly handler = handlerFor(this.db, undefined, {
    supabaseSecretKey: SECRET_KEY,
    previewModules: ORDERS_PREVIEW,
  })
}

/** A small factory with a team, VAT and invoices to companies (orders on credit with LPOs). */
export const FACTORY: SetupAnswers = {
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

/** An order's item line. */
export function orderItem(productId: string, qty: string, unitPrice: string, extra: object = {}) {
  return { kind: 'item', id: newId(), productId, qty, unitPrice, ...extra }
}

/** An order's delivery charged to the customer. */
export function orderDelivery(amount: string, extra: object = {}) {
  return { kind: 'delivery', id: newId(), amount, ...extra }
}

/** A business, its owner and a way to call as them, with orders helpers. */
export class OrderScope extends ProfitScope {
  static override async open(api: PurchasingApi, answers?: SetupAnswers): Promise<OrderScope> {
    const { id, owner } = await api.business(answers)
    return new OrderScope(api, id, owner)
  }

  async customer(input: object = {}, person: Person = this.owner): Promise<CustomerDto> {
    return ok(
      await this.as<CustomerDto>(person, 'customer.create', {
        id: newId(),
        name: `Fatima ${tag()}`,
        phone: '050 123 4567',
        ...input,
      }),
    )
  }

  /** A pending order (the envelope's data). */
  async order(input: object, person: Person = this.owner): Promise<OrderDto> {
    return ok(
      await this.as<{ data: OrderDto }>(person, 'order.create', {
        id: newId(),
        businessDate: await this.today(),
        ...input,
      }),
    ).data
  }

  async getOrder(id: string, person: Person = this.owner): Promise<OrderDto> {
    return ok(await this.as<{ data: OrderDto }>(person, 'order.get', { id })).data
  }

  async orders(input: object = {}, person: Person = this.owner): Promise<OrderListDto> {
    return ok(await this.as<OrderListDto>(person, 'order.list', input))
  }

  async deliver(order: OrderDto, businessDate?: string, person: Person = this.owner) {
    return ok(
      await this.as<{ data: OrderDto }>(person, 'order.deliver', {
        id: order.id,
        version: order.version,
        ...(businessDate ? { businessDate } : {}),
      }),
    ).data
  }

  async undo(id: string, person: Person = this.owner): Promise<OrderDto> {
    return ok(await this.as<{ data: OrderDto }>(person, 'order.undoDelivery', { id })).data
  }

  async cancel(order: OrderDto, person: Person = this.owner): Promise<OrderDto> {
    return ok(
      await this.as<{ data: OrderDto }>(person, 'order.cancel', {
        id: order.id,
        version: order.version,
      }),
    ).data
  }

  /** A customer payment (or money given back) on an order or a sale. */
  async pay(
    document: { orderId: string } | { saleId: string },
    amount: string,
    extra: object = {},
    person: Person = this.owner,
  ): Promise<DocumentPaymentsDto> {
    return ok(
      await this.as<DocumentPaymentsDto>(person, 'customerPayment.record', {
        id: newId(),
        ...document,
        businessDate: await this.today(),
        method: 'cash',
        amount,
        ...extra,
      }),
    )
  }

  async refund(input: object, person: Person = this.owner): Promise<SaleDto> {
    return ok(await this.as<{ data: SaleDto }>(person, 'sale.refund', { id: newId(), ...input }))
      .data
  }

  async receivables(input: object = {}, person: Person = this.owner): Promise<ReceivableListDto> {
    return ok(await this.as<ReceivableListDto>(person, 'receivable.list', input))
  }
}
