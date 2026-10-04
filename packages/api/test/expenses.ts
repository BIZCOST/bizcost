import type {
  CostCategoryDto,
  CostCategoryListDto,
  ExpenseDto,
  ExpensePaymentsDto,
  ExpensePaysInput,
  RunningCostDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { ok, PurchasingApi, Scope } from './purchasing'

// Helpers of the expenses and running-costs tests (ROADMAP.md M2 Step 5): the purchasing tests' API
// (released since M2 Step 7), and expenses, categories and running costs made through the API.

export type Envelope<T> = { data: T; meta: { redacted: string[] } }

export class ExpensesApi extends PurchasingApi {}

/** A business, its owner and a way to call as them, with expense helpers. */
export class ExpenseScope extends Scope {
  static override async open(
    api: PurchasingApi,
    answers?: Parameters<typeof Scope.open>[1],
  ): Promise<ExpenseScope> {
    const { id, owner } = await api.business(answers)
    return new ExpenseScope(api, id, owner)
  }

  /** The business's categories (active and archived), by name. */
  async categories(): Promise<CostCategoryDto[]> {
    return ok(
      await this.run<CostCategoryListDto>('costCategory.list', { status: 'all', limit: 100 }),
    ).items
  }

  /** A category of its own (a fresh name). */
  async category(name = `Category ${newId().slice(-8)}`): Promise<CostCategoryDto> {
    return ok(await this.run<CostCategoryDto>('costCategory.create', { id: newId(), name }))
  }

  /** An expense's input: 100 before VAT at 5 %, a tax invoice paid in cash, dated `date`. */
  expenseInput(categoryId: string, date: string, extra: object = {}) {
    return {
      id: newId(),
      categoryId,
      businessDate: date,
      documentType: 'tax_invoice',
      paymentMethod: 'cash',
      amount: '100',
      vatRate: '5',
      ...extra,
    }
  }

  async expenseDraft(input: object): Promise<ExpenseDto> {
    return ok(await this.run<Envelope<ExpenseDto>>('expense.create', input)).data
  }

  /**
   * Finalizes it, saying what it pays when given (D-216: needed when its category has a running cost
   * for its month and the draft does not say it).
   */
  async postExpense(
    expense: Pick<ExpenseDto, 'id' | 'version'>,
    pays?: ExpensePaysInput,
  ): Promise<ExpenseDto> {
    return ok(
      await this.run<Envelope<ExpenseDto>>('expense.post', {
        id: expense.id,
        version: expense.version,
        ...(pays ? { pays } : {}),
      }),
    ).data
  }

  /** A posted expense (saying what it pays when given, D-216). */
  async spend(input: object, pays?: ExpensePaysInput): Promise<ExpenseDto> {
    return this.postExpense(await this.expenseDraft(input), pays)
  }

  async expensePayments(expenseId: string) {
    return ok(
      await this.run<Envelope<ExpensePaymentsDto['data']>>('expensePayment.list', { expenseId }),
    ).data
  }

  async runningCost(input: object): Promise<RunningCostDto> {
    return ok(await this.run<Envelope<RunningCostDto>>('runningCost.create', input)).data
  }
}

/** What an expense pays (D-216): the bill of a running cost, or an extra. */
export const billOf = (runningCost: { id: string }): ExpensePaysInput => ({
  kind: 'running_cost',
  runningCostId: runningCost.id,
})
export const EXTRA: ExpensePaysInput = { kind: 'extra' }
