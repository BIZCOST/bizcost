import type {
  CountDto,
  CountLineDto,
  CountListDto,
  CountReviewDto,
  StockCardDto,
  StockListDto,
  StockUntrackedDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { handlerFor, SECRET_KEY } from './helpers'
import { CostScope } from './product-costs'
import { ok, PurchasingApi, type Person } from './purchasing'

// Helpers of the stock tests (ROADMAP.md M4 Step 2): Stock is planned until Release A of M4, so the
// API runs with the dev-only preview of it (D-125), as a local server does; `released` is the API as
// deployed (no preview). Businesses, materials, purchases and recipes are made through the API; counts
// are started, filled, finalized and reversed through it; the database is read as postgres to compare
// the ledger with its projections (ledgerDrift).

/** The modules the stock suites preview (D-125). */
export const PREVIEW_MODULES = ['inventory'] as const

export class StockApi extends PurchasingApi {
  /** The API with the dev-only preview of Stock (the secret key for Storage). */
  override readonly handler = handlerFor(this.db, undefined, {
    supabaseSecretKey: SECRET_KEY,
    previewModules: PREVIEW_MODULES,
  })
  /** The API as deployed: Stock is planned, so its procedures answer MODULE_DISABLED. */
  readonly released = handlerFor(this.db, undefined, { supabaseSecretKey: SECRET_KEY })
}

/** A count line's quantity typed in litres. */
export const litres = (qty: string) => [{ qty, unit: 'l' }]

/** A business, its owner and a way to call as them, with stock helpers. */
export class StockScope extends CostScope {
  static override async open(api: PurchasingApi, answers?: SetupAnswers): Promise<StockScope> {
    const { id, owner } = await api.business(answers)
    return new StockScope(api, id, owner)
  }

  /** `count.start` as `person` (the owner by default): the draft. */
  async start(input: object, person: Person = this.owner): Promise<CountDto> {
    return ok(await this.as<{ data: CountDto }>(person, 'count.start', { id: newId(), ...input }))
      .data
  }

  async count(id: string, person: Person = this.owner): Promise<CountDto> {
    return ok(await this.as<{ data: CountDto }>(person, 'count.get', { id })).data
  }

  /** Saves `parts` on the count's line of `materialId` (at `locationId`, else its only one). */
  async save(
    count: CountDto,
    materialId: string,
    parts: object[],
    person: Person = this.owner,
    locationId?: string,
  ): Promise<CountLineDto> {
    const line = lineOf(count, materialId, locationId)
    return ok(
      await this.as<{ data: CountLineDto }>(person, 'count.saveLine', {
        countId: count.id,
        lineId: line.id,
        parts,
        version: line.version,
      }),
    ).data
  }

  async review(id: string, person: Person = this.owner): Promise<CountReviewDto['data']> {
    return ok(await this.as<CountReviewDto>(person, 'count.review', { id })).data
  }

  async finalize(count: CountDto, person: Person = this.owner): Promise<CountDto> {
    return ok(
      await this.as<{ data: CountDto }>(person, 'count.finalize', {
        id: count.id,
        version: count.version,
      }),
    ).data
  }

  async reverseCount(id: string, person: Person = this.owner): Promise<CountDto> {
    return ok(await this.as<{ data: CountDto }>(person, 'count.reverse', { id })).data
  }

  /** A first count of `materialIds` on `date`, each line counted as `counted(materialId, line)`. */
  async opening(
    date: string,
    materialIds: string[],
    counted: (materialId: string, locationId: string) => object[],
  ): Promise<CountDto> {
    let count = await this.start({ kind: 'opening', businessDate: date, materialIds })
    for (const line of count.lines) {
      await this.save(
        count,
        line.materialId,
        counted(line.materialId, line.locationId),
        this.owner,
        line.locationId,
      )
    }
    count = await this.count(count.id)
    return this.finalize(count)
  }

  async stock(input: object = {}, person: Person = this.owner): Promise<StockListDto> {
    return ok(await this.as<StockListDto>(person, 'stock.list', input))
  }

  async untracked(input: object = {}, person: Person = this.owner) {
    return ok(await this.as<StockUntrackedDto>(person, 'stock.untracked', input))
  }

  async card(input: object, person: Person = this.owner): Promise<StockCardDto> {
    return ok(await this.as<StockCardDto>(person, 'stock.card', input))
  }

  async counts(input: object = {}, person: Person = this.owner): Promise<CountListDto> {
    return ok(await this.as<CountListDto>(person, 'count.list', input))
  }
}

/** The count's line of `materialId` (at `locationId` when given). */
export function lineOf(count: CountDto, materialId: string, locationId?: string): CountLineDto {
  const line = count.lines.find(
    (l) => l.materialId === materialId && (locationId === undefined || l.locationId === locationId),
  )
  if (!line) throw new Error(`no line of ${materialId}`)
  return line
}
