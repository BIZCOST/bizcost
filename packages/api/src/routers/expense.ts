import {
  correctExpenseInput,
  createExpenseInput,
  expenseIdInput,
  expenseListDto,
  expenseListInput,
  expensePaymentsDto,
  expensePaymentsInput,
  expenseResultDto,
  expenseSettingsDto,
  expenseVersionInput,
  mineExpenseGetInput,
  mineExpenseListDto,
  mineExpenseListInput,
  mineExpenseResultDto,
  okDto,
  purchasePayersDto,
  recordExpensePaymentInput,
  rejectExpenseInput,
  reverseExpensePaymentInput,
  updateExpenseInput,
  updateExpenseSettingsInput,
} from '@bizcost/contracts'
import {
  approveExpense,
  correctExpense,
  createExpense,
  discardExpense,
  getExpense,
  getExpenseSettings,
  listExpenses,
  postExpense,
  rejectExpense,
  reverseExpense,
  submitExpense,
  updateExpense,
  updateExpenseSettings,
} from '../services/expenses'
import { getMineExpense, listMineExpenses } from '../services/mine'
import {
  listExpensePayments,
  listPayers,
  recordExpensePayment,
  reverseExpensePayment,
} from '../services/payments'
import {
  businessProcedure,
  requireCapability,
  requireModule,
  requirePermission,
  router,
} from '../trpc'

/**
 * Expenses (services/expenses.ts): module `expenses` (planned until M2 Step 7; the dev-only preview
 * reaches it before then, D-125), then expenses.documents.view to read, .manage for drafts and to send
 * them for approval (without supplier prices, only one's own: the service checks it, D-184), .approve to approve or reject, .post to finalize, .reverse to reverse, and
 * .reverse with .manage to correct; expenses.approval.manage (with a team) for the approval setting.
 * Outputs are withMeta(): amounts are removed for members without data.supplier_price.view (D-165).
 */
export const expensesModule = businessProcedure.use(requireModule('expenses'))
export const viewExpenses = expensesModule.use(requirePermission('expenses.documents.view'))
export const manageExpenses = expensesModule.use(requirePermission('expenses.documents.manage'))
const approveExpenses = expensesModule.use(requirePermission('expenses.documents.approve'))
const postExpenses = expensesModule.use(requirePermission('expenses.documents.post'))
const reverseExpenses = expensesModule.use(requirePermission('expenses.documents.reverse'))

export const expenseRouter = router({
  /** `expense.list`: newest business day first, filters and a cursor. */
  list: viewExpenses
    .input(expenseListInput)
    .output(expenseListDto)
    .query(({ ctx, input }) => listExpenses(ctx, input)),
  /** `expense.get`: with who entered, sent, approved or rejected it. */
  get: viewExpenses
    .input(expenseIdInput)
    .output(expenseResultDto)
    .query(({ ctx, input }) => getExpense(ctx, input)),
  /**
   * `expense.mine` ("My expenses", D-181): the expenses the caller entered or paid from their own
   * money, with their amounts even without supplier prices (only the caller's own rows; not tagged).
   */
  mine: viewExpenses
    .input(mineExpenseListInput)
    .output(mineExpenseListDto)
    .query(({ ctx, input }) => listMineExpenses(ctx, input)),
  /** `expense.getMine`: one of the caller's own expenses with its amounts (NOT_FOUND otherwise). */
  getMine: viewExpenses
    .input(mineExpenseGetInput)
    .output(mineExpenseResultDto)
    .query(({ ctx, input }) => getMineExpense(ctx, input)),
  /** `expense.payers`: the active members an expense may say paid from their own money. */
  payers: manageExpenses.output(purchasePayersDto).query(({ ctx }) => listPayers(ctx)),
  /** `expense.create`: a draft, idempotent on the client's id. */
  create: manageExpenses
    .input(createExpenseInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => createExpense(ctx, input)),
  /** `expense.update`: the whole draft (or rejected expense), `version` as read. */
  update: manageExpenses
    .input(updateExpenseInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => updateExpense(ctx, input)),
  /** `expense.discard`: a draft is taken out, with its receipts. */
  discard: manageExpenses
    .input(expenseVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardExpense(ctx, input)),
  /** `expense.submit`: sent for approval (only while the business requires it). Idempotent. */
  submit: manageExpenses
    .input(expenseVersionInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => submitExpense(ctx, input)),
  /** `expense.approve`: an expense sent for approval is approved. Idempotent. */
  approve: approveExpenses
    .input(expenseVersionInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => approveExpense(ctx, input)),
  /** `expense.reject`: sent back, with an optional reason; it is then edited like a draft. */
  reject: approveExpenses
    .input(rejectExpenseInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => rejectExpense(ctx, input)),
  /** `expense.post` ("Finalize"): it counts from now. Idempotent. */
  post: postExpenses
    .input(expenseVersionInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => postExpense(ctx, input)),
  /** `expense.reverse`: as if never posted. Idempotent. */
  reverse: reverseExpenses
    .input(expenseIdInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => reverseExpense(ctx, input)),
  /**
   * `expense.correct`: reverse, and a copy as a new draft (`newId`); needs .reverse and .manage, and
   * supplier prices visible (the copy carries the amounts; the service checks it, D-184).
   */
  correct: reverseExpenses
    .use(requirePermission('expenses.documents.manage'))
    .input(correctExpenseInput)
    .output(expenseResultDto)
    .mutation(({ ctx, input }) => correctExpense(ctx, input)),
  /** `expense.settings`: whether expenses need approval (D-164). */
  settings: viewExpenses.output(expenseSettingsDto).query(({ ctx }) => getExpenseSettings(ctx)),
  /** `expense.updateSettings`: turn approval on or off (Owner and Admin; a business with a team). */
  updateSettings: expensesModule
    .use(requirePermission('expenses.approval.manage'))
    .use(requireCapability('has_team'))
    .input(updateExpenseSettingsInput)
    .output(expenseSettingsDto)
    .mutation(({ ctx, input }) => updateExpenseSettings(ctx, input)),
})

/**
 * What an expense bought on credit or paid by a member still owes, and paying it
 * (services/payments.ts, as purchasePayment.*; D-166): expenses.payments.view to read and
 * expenses.payments.record to record or reverse a payment (Owner, Admin and Manager). Amounts are
 * `supplier_price`; recording a payment needs supplier prices visible (FORBIDDEN otherwise).
 */
const viewExpensePayments = viewExpenses.use(requirePermission('expenses.payments.view'))
const recordExpensePayments = viewExpensePayments.use(requirePermission('expenses.payments.record'))

export const expensePaymentRouter = router({
  /** `expensePayment.list`: an expense's payments and what is still owed on it. */
  list: viewExpensePayments
    .input(expensePaymentsInput)
    .output(expensePaymentsDto)
    .query(({ ctx, input }) => listExpensePayments(ctx, input)),
  /** `expensePayment.record`: a payment of what is owed; idempotent on the client's id. */
  record: recordExpensePayments
    .input(recordExpensePaymentInput)
    .output(expensePaymentsDto)
    .mutation(({ ctx, input }) => recordExpensePayment(ctx, input)),
  /** `expensePayment.reverse`: a payment recorded by mistake stops counting. Idempotent. */
  reverse: recordExpensePayments
    .input(reverseExpensePaymentInput)
    .output(expensePaymentsDto)
    .mutation(({ ctx, input }) => reverseExpensePayment(ctx, input)),
})
