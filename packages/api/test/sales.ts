import type {
  DaySheetDto,
  MaterialDto,
  ProductDto,
  SaleDto,
  SaleListDto,
  SalesChannelDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { handlerFor, SECRET_KEY } from './helpers'
import { CostScope, tag } from './product-costs'
import { ok, PurchasingApi, purchaseInput, type Person } from './purchasing'

// Helpers of the sales tests (ROADMAP.md M3 Step 2): Sales is planned until Release A (Step 6), so the
// API runs with the dev-only preview of it (D-125), as a local server does. Businesses, products,
// recipes and purchases are made through the API; sales are entered, finalized, reversed and
// corrected through it; the database is read as postgres to check what a sale froze.

/** The modules the sales suites preview (D-125). */
export const PREVIEW_MODULES = ['sales'] as const

export class SalesApi extends PurchasingApi {
  override readonly handler = handlerFor(this.db, undefined, {
    supabaseSecretKey: SECRET_KEY,
    previewModules: PREVIEW_MODULES,
  })
}

/** A coffee shop with a POS and staff, VAT-registered (persona 2): terminology profile `food`. */
export const CAFE: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: true,
  vat: 'yes',
}

/** The café with a second branch. */
export const CAFE_BRANCHES: SetupAnswers = { ...CAFE, branches: true }

/** An item line: `qty` of `productId` at `unitPrice`. */
export function item(productId: string, qty: string, unitPrice: string, extra: object = {}) {
  return { kind: 'item', id: newId(), productId, qty, unitPrice, ...extra }
}

/** A delivery line charged to the customer. */
export function delivery(amount: string, extra: object = {}) {
  return { kind: 'delivery', id: newId(), amount, ...extra }
}

/** A purchase line in a pack or a unit. */
export function bought(materialId: string, qty: string, unitPrice: string, unit: object) {
  return { kind: 'material', id: newId(), materialId, qty, unitPrice, ...unit }
}

/** `date` moved by `days` (YYYY-MM-DD). */
export function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** A business, its owner and a way to call as them, with sales helpers. */
export class SaleScope extends CostScope {
  static override async open(api: PurchasingApi, answers?: SetupAnswers): Promise<SaleScope> {
    const { id, owner } = await api.business(answers)
    return new SaleScope(api, id, owner)
  }

  async channels(person: Person = this.owner): Promise<SalesChannelDto[]> {
    return ok(await this.as<{ data: { items: SalesChannelDto[] } }>(person, 'channel.list')).data
      .items
  }

  async channel(input: object): Promise<SalesChannelDto> {
    return ok(
      await this.run<{ data: SalesChannelDto }>('channel.create', {
        id: newId(),
        name: `Channel ${tag()}`,
        kind: 'delivery_app',
        ...input,
      }),
    ).data
  }

  private defaultChannel: string | undefined

  /** The channel a sale names when a test does not say: the shop's, else the first one. */
  async channelId(): Promise<string> {
    if (this.defaultChannel === undefined) {
      const channels = await this.channels()
      this.defaultChannel = (channels.find((c) => c.kind === 'shop') ?? channels[0])!.id
    }
    return this.defaultChannel
  }

  /** A draft sale (the envelope's data), in the default channel unless `input` names one. */
  async saleDraft(input: object, person: Person = this.owner): Promise<SaleDto> {
    return ok(
      await this.as<{ data: SaleDto }>(person, 'sale.create', {
        id: newId(),
        source: 'single',
        channelId: await this.channelId(),
        ...input,
      }),
    ).data
  }

  async postSale(sale: SaleDto, person: Person = this.owner): Promise<SaleDto> {
    return ok(
      await this.as<{ data: SaleDto }>(person, 'sale.post', { id: sale.id, version: sale.version }),
    ).data
  }

  /** A finalized sale. */
  async sell(input: object, person: Person = this.owner): Promise<SaleDto> {
    return this.postSale(await this.saleDraft(input, person), person)
  }

  async sale(id: string, person: Person = this.owner): Promise<SaleDto> {
    return ok(await this.as<{ data: SaleDto }>(person, 'sale.get', { id })).data
  }

  async reverseSale(id: string, person: Person = this.owner): Promise<SaleDto> {
    return ok(await this.as<{ data: SaleDto }>(person, 'sale.reverse', { id })).data
  }

  async sales(input: object = {}, person: Person = this.owner): Promise<SaleListDto> {
    return ok(await this.as<SaleListDto>(person, 'sale.list', input))
  }

  async sheet(input: object, person: Person = this.owner): Promise<DaySheetDto['data']> {
    return ok(await this.as<DaySheetDto>(person, 'sale.daySheet', input)).data
  }

  /** The Spanish Latte (18 g beans, 200 ml milk, 25 ml condensed milk, cup, lid, straw) bought on `day`. */
  async spanishLatte(
    day: string,
    price = '18',
  ): Promise<{
    latte: ProductDto
    materials: Record<'beans' | 'milk' | 'condensed' | 'cup' | 'lid' | 'straw', MaterialDto>
    packs: Record<'bag' | 'carton' | 'box' | 'sleeve' | 'lidBox' | 'strawPack', string>
  }> {
    const packs = {
      bag: newId(),
      bottle: newId(),
      carton: newId(),
      can: newId(),
      box: newId(),
      sleeve: newId(),
      lidBox: newId(),
      strawPack: newId(),
    }
    const beans = await this.newMaterial({
      name: `Coffee beans ${tag()}`,
      unit: 'kg',
      packs: [{ id: packs.bag, name: 'bag', qty: '1', ofUnit: 'kg' }],
    })
    const milk = await this.newMaterial({
      name: `Milk ${tag()}`,
      unit: 'l',
      packs: [
        { id: packs.bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
        { id: packs.carton, name: 'carton', qty: '12', ofPackId: packs.bottle },
      ],
    })
    const condensed = await this.newMaterial({
      name: `Condensed milk ${tag()}`,
      unit: 'l',
      packs: [
        { id: packs.can, name: 'can', qty: '385', ofUnit: 'ml' },
        { id: packs.box, name: 'box', qty: '24', ofPackId: packs.can },
      ],
    })
    const cup = await this.newMaterial({
      name: `Cup 12 oz ${tag()}`,
      unit: 'piece',
      packs: [{ id: packs.sleeve, name: 'sleeve', qty: '50', ofUnit: 'piece' }],
    })
    const lid = await this.newMaterial({
      name: `Lid ${tag()}`,
      unit: 'piece',
      packs: [{ id: packs.lidBox, name: 'box', qty: '100', ofUnit: 'piece' }],
    })
    const straw = await this.newMaterial({
      name: `Straw ${tag()}`,
      unit: 'piece',
      packs: [{ id: packs.strawPack, name: 'pack', qty: '200', ofUnit: 'piece' }],
    })
    // What the café paid (no VAT on the invoice): 2 bags of beans at 65, a carton of milk at 72, a
    // box of condensed milk at 95, 2 sleeves of cups at 12.50, a box of lids at 9, a pack of straws
    // at 7 (M2's Spanish Latte, 3.002034632035 a cup).
    await this.buy(
      purchaseInput(day, [
        bought(beans.id, '2', '65', { packId: packs.bag }),
        bought(milk.id, '1', '72', { packId: packs.carton }),
        bought(condensed.id, '1', '95', { packId: packs.box }),
        bought(cup.id, '2', '12.5', { packId: packs.sleeve }),
        bought(lid.id, '1', '9', { packId: packs.lidBox }),
        bought(straw.id, '1', '7', { packId: packs.strawPack }),
      ]),
    )
    const latte = await this.product({ name: `Spanish Latte ${tag()}`, defaultPrice: price })
    await this.recipe(latte.id, [
      { id: newId(), materialId: beans.id, qty: '18', unit: 'g' },
      { id: newId(), materialId: milk.id, qty: '200', unit: 'ml' },
      { id: newId(), materialId: condensed.id, qty: '25', unit: 'ml' },
      { id: newId(), materialId: cup.id, qty: '1', unit: 'piece' },
      { id: newId(), materialId: lid.id, qty: '1', unit: 'piece' },
      { id: newId(), materialId: straw.id, qty: '1', unit: 'piece' },
    ])
    return {
      latte,
      materials: { beans, milk, condensed, cup, lid, straw },
      packs: {
        bag: packs.bag,
        carton: packs.carton,
        box: packs.box,
        sleeve: packs.sleeve,
        lidBox: packs.lidBox,
        strawPack: packs.strawPack,
      },
    }
  }

  /** The frozen materials of a sale, read as postgres. */
  async frozen(saleId: string) {
    return this.api.admin<
      { material_id: string; base_qty: string; unit_cost: string | null; cost: string | null }[]
    >`
      select material_id, trim_scale(base_qty)::text as base_qty,
             trim_scale(unit_cost)::text as unit_cost, trim_scale(cost)::text as cost
        from app.sale_line_materials where business_id = ${this.id} and sale_id = ${saleId}
       order by material_id`
  }

  /** Every stock movement and cost row of the business, as postgres: sales never change them. */
  async stockState() {
    const [movements] = await this.api.admin<{ h: string }[]>`
      select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.seq), '')) as h
        from app.stock_movements m where m.business_id = ${this.id}`
    const [costs] = await this.api.admin<{ h: string }[]>`
      select md5(coalesce(string_agg(
               concat_ws(':', c.material_id, c.qty, c.value, c.avg_cost, c.last_seq), '|'
               order by c.material_id), '')) as h
        from app.material_costs c
       where c.business_id = ${this.id} and (c.qty <> 0 or c.value <> 0 or c.last_seq is not null)`
    const [balances] = await this.api.admin<{ h: string }[]>`
      select md5(coalesce(string_agg(concat_ws(':', b.location_id, b.material_id, b.qty), '|'
               order by b.location_id, b.material_id), '')) as h
        from app.stock_balances b where b.business_id = ${this.id}`
    return { movements: movements?.h, costs: costs?.h, balances: balances?.h }
  }
}

/** A create's input without its id and source: the fields of the update of the same sale. */
export function updateFieldsOf<T extends Record<string, unknown>>(
  input: T,
): Omit<T, 'id' | 'source'> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'id' && key !== 'source'),
  ) as Omit<T, 'id' | 'source'>
}
