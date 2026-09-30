import type {
  MaterialDto,
  ProductCostBreakdownDto,
  ProductCostListDto,
  ProductCostSettingsDto,
  ProductDto,
  RecipeResultDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { ExpenseScope } from './expenses'
import { ok, PurchasingApi, type Person } from './purchasing'

// Helpers of the product-cost tests (ROADMAP.md M2 Step 6): the expenses tests' API (released since
// M2 Step 7), and products, recipes, running costs and the product-cost settings made through the
// API.

export class ProductCostsApi extends PurchasingApi {}

export const tag = () => newId().slice(-8)

/** A business, its owner and a way to call as them, with product-cost helpers. */
export class CostScope extends ExpenseScope {
  static override async open(
    api: PurchasingApi,
    answers?: Parameters<typeof ExpenseScope.open>[1],
  ): Promise<CostScope> {
    const { id, owner } = await api.business(answers)
    return new CostScope(api, id, owner)
  }

  async newMaterial(input: object): Promise<MaterialDto> {
    return ok(await this.run<MaterialDto>('material.create', { id: newId(), ...input }))
  }

  async product(input: object = {}): Promise<ProductDto> {
    return ok(
      await this.run<ProductDto>('product.create', {
        id: newId(),
        name: `Product ${tag()}`,
        type: 'product',
        unit: 'piece',
        ...input,
      }),
    )
  }

  async updateProduct(product: ProductDto, change: object): Promise<ProductDto> {
    const { id, version, name, description, type, unit, defaultPrice } = product
    return ok(
      await this.run<ProductDto>('product.update', {
        id,
        version,
        name,
        description,
        type,
        unit,
        defaultPrice,
        vatCategory: product.vatCategory,
        priceIncludesVat: product.priceIncludesVat,
        ...change,
      }),
    )
  }

  async recipe(productId: string, lines: object[], yieldQty?: string) {
    return ok(
      await this.run<RecipeResultDto>('recipe.save', {
        productId,
        version: 0,
        lines,
        ...(yieldQty ? { yieldQty } : {}),
      }),
    ).data
  }

  async breakdown(productId: string, person: Person = this.owner) {
    return ok(await this.as<ProductCostBreakdownDto>(person, 'productCost.get', { productId })).data
  }

  async costList(input: object = {}, person: Person = this.owner) {
    return ok(await this.as<ProductCostListDto>(person, 'productCost.list', input)).data
  }

  async settings(change: object) {
    return ok(await this.run<ProductCostSettingsDto>('productCost.updateSettings', change)).data
  }
}
