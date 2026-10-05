import type {
  DashboardCardsDto,
  MaterialDto,
  ProductDto,
  ProfitSummaryDto,
  SalesChannelDto,
} from '@bizcost/contracts'
import { addMonths, daysIn, monthOf, newId, type BusinessMonth } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { handlerFor, SECRET_KEY } from './helpers'
import { tag } from './product-costs'
import { ok, PurchasingApi, purchaseInput, type Person } from './purchasing'
import { bought, SaleScope } from './sales'

// Helpers of the real-profit tests (ROADMAP.md M3 Step 3): Sales and Reports are planned until Release
// A (Step 6), so the API runs with the dev-only preview of both (D-125), as a local server does.
// Businesses, products, recipes, purchases, running costs, expenses and sales are made through the
// API; months are counted from the business's today, so the tests hold on any day they run.

/** The modules the real-profit suites preview (D-125). */
export const PROFIT_PREVIEW = ['sales', 'reports'] as const

export class ProfitApi extends PurchasingApi {
  override readonly handler = handlerFor(this.db, undefined, {
    supabaseSecretKey: SECRET_KEY,
    previewModules: PROFIT_PREVIEW,
  })
}

/** Day `n` of `month` (YYYY-MM-DD). */
export const dayOf = (month: BusinessMonth, n: number) => `${month}-${String(n).padStart(2, '0')}`
/** The last day of `month`. */
export const lastOf = (month: BusinessMonth) => dayOf(month, daysIn(month))

export type Summary = ProfitSummaryDto['data']
export type Cards = DashboardCardsDto['data']

/** A business, its owner and a way to call as them, with real-profit helpers. */
export class ProfitScope extends SaleScope {
  static override async open(api: PurchasingApi, answers?: SetupAnswers): Promise<ProfitScope> {
    const { id, owner } = await api.business(answers)
    return new ProfitScope(api, id, owner)
  }

  /** This month and the month before, from the business's today. */
  async months(): Promise<{ today: string; month: BusinessMonth; last: BusinessMonth }> {
    const today = await this.today()
    const month = monthOf(today)
    return { today, month, last: addMonths(month, -1) }
  }

  async summary(input: object, person: Person = this.owner): Promise<Summary> {
    return ok(await this.as<ProfitSummaryDto>(person, 'profit.summary', input)).data
  }

  async cards(person: Person = this.owner): Promise<Cards> {
    return ok(await this.as<DashboardCardsDto>(person, 'dashboard.cards')).data
  }

  /** A category of the business by its starter key's English name ("Rent", "Other"…). */
  async categoryNamed(name: string): Promise<string> {
    const found = (await this.categories()).find((c) => c.name === name)
    if (!found) throw new Error(`no category ${name}`)
    return found.id
  }

  /** A running cost of `amount` a month from `startsOn`, in a category of its own. */
  async monthly(amount: string, startsOn: string, name = `Rent ${tag()}`) {
    const category = await this.category(`Costs ${tag()}`)
    return this.runningCost({
      id: newId(),
      name,
      categoryId: category.id,
      amount,
      startsOn,
    })
  }

  /**
   * A finalized expense of `amount` (before VAT, at `vatRate` %) for `periodMonth`, dated `date`, in a
   * category of its own (no running cost: nothing to say) unless `categoryId`, saying what it pays.
   */
  async expense(
    amount: string,
    date: string,
    periodMonth: BusinessMonth,
    extra: { pays?: object; categoryId?: string; vatRate?: string } = {},
  ) {
    const categoryId = extra.categoryId ?? (await this.category(`Bills ${tag()}`)).id
    const input = this.expenseInput(categoryId, date, {
      amount,
      vatRate: extra.vatRate ?? '0',
      periodMonth,
      ...(extra.pays ? { pays: extra.pays } : {}),
    })
    return this.spend(input)
  }

  /** A material in pieces bought on `date` at `price` a piece (no VAT on the invoice). */
  async pieceMaterial(
    name: string,
    price: string,
    date: string,
    qty = '1000',
  ): Promise<MaterialDto> {
    const material = await this.newMaterial({ name: `${name} ${tag()}`, unit: 'piece' })
    await this.buy(purchaseInput(date, [bought(material.id, qty, price, { unit: 'piece' })]))
    return material
  }

  /** A product at `price` (before VAT) made of one piece of `material`. */
  async madeOf(material: MaterialDto, price: string, extra: object = {}): Promise<ProductDto> {
    const product = await this.product({ name: `Product ${tag()}`, defaultPrice: price, ...extra })
    await this.recipe(product.id, [
      { id: newId(), materialId: material.id, qty: '1', unit: 'piece' },
    ])
    return product
  }

  /** A service at `price` (no recipe). */
  async service(price: string, extra: object = {}): Promise<ProductDto> {
    return this.product({
      name: `Service ${tag()}`,
      type: 'service',
      unit: 'piece',
      defaultPrice: price,
      ...extra,
    })
  }

  /** A delivery app channel (Talabat) with `feePercent`. */
  async deliveryApp(
    feePercent: string | null,
    name = `Talabat ${tag()}`,
  ): Promise<SalesChannelDto> {
    return this.channel({ name, kind: 'delivery_app', ...(feePercent ? { feePercent } : {}) })
  }
}
