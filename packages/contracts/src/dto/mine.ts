import { z } from 'zod'
import { withMeta } from '../envelope'
import { DOCUMENT_PAGE_SIZE, DOCUMENT_PAGE_SIZE_MAX } from '../purchasing'
import { zBusinessDate, zBusinessMonth, zDecimal, zUuid } from '../primitives'
import { expenseDto, expensePaysDto, expenseStatusDto } from './expenses'
import {
  documentStatusDto,
  payableKindDto,
  paymentMethodDto,
  purchaseDocumentTypeDto,
  settlementMethodDto,
} from './purchases'

// A member's own records (the owner's answers of 2026-09-29, A4; D-181). A member sees the amounts of
// the expenses they entered or paid from their own money, and of the final purchases and expenses the
// business owes them for (what they paid personally) with what was paid back, even without supplier
// prices: they typed or paid those amounts themselves.
//
// These outputs are deliberately NOT tagged sensitive(): each procedure returns only rows where the
// caller is the one who entered the record (its created_by, and of every expense a corrected copy was
// copied from) or the member who paid it (any membership of the caller in the business), filtered in
// SQL by the service, never anyone else's amounts. The
// general redaction stays as it is: expense.get, expense.list, payable.list and the payment
// procedures still remove supplier prices for members who may not see them. The redaction oracle
// holds every procedure here to "your own amounts only" (hardening/redaction-oracle.api.test.ts).

// ---------------------------------------------------------------------------------------------------
// My expenses (module expenses, expenses.documents.view)
// ---------------------------------------------------------------------------------------------------

/** `expense.mine`: the caller's own expenses, newest business day first. */
export const mineExpenseListInput = z
  .object({
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(DOCUMENT_PAGE_SIZE_MAX).default(DOCUMENT_PAGE_SIZE),
  })
  .prefault({})
export type MineExpenseListInput = z.input<typeof mineExpenseListInput>

export const mineExpenseDto = z.object({
  id: zUuid,
  status: expenseStatusDto,
  businessDate: zBusinessDate,
  /** The month the bill is for (`YYYY-MM`). */
  periodMonth: zBusinessMonth,
  categoryName: z.string(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  documentType: purchaseDocumentTypeDto,
  paymentMethod: paymentMethodDto,
  /** The caller entered it (and, for a copy made by a correction, what it was copied from). */
  enteredByMe: z.boolean(),
  /** The caller paid it from their own money (`paid_by_member`). */
  paidByMe: z.boolean(),
  /**
   * What it pays in a category that has running costs (D-216), as expense.get says it: the running
   * cost's name only to a member who may see running costs.
   */
  pays: expensePaysDto,
  currency: z.string(),
  /** What it came to, with its VAT (the caller's own record: not redacted). */
  total: zDecimal,
  /**
   * A final expense the caller paid from their own money: what was paid back to them and what is still
   * owed to them (never below zero). A final one bought on credit or paid by another member: the same
   * only for a member who may see payments (expenses.payments.view and supplier prices), null for the
   * others. Null before it is final, after it is reversed, and when it was paid when bought.
   */
  paid: zDecimal.nullable(),
  outstanding: zDecimal.nullable(),
})
export type MineExpenseDto = z.infer<typeof mineExpenseDto>

export const mineExpenseListDto = z.object({
  items: z.array(mineExpenseDto),
  /** The next page's cursor; null on the last page. */
  nextCursor: z.string().nullable(),
})
export type MineExpenseListDto = z.infer<typeof mineExpenseListDto>

/** `expense.getMine`: one of the caller's own expenses (NOT_FOUND for anyone else's). */
export const mineExpenseGetInput = z.object({ id: zUuid })
export type MineExpenseGetInput = z.input<typeof mineExpenseGetInput>

/**
 * The expense as expense.get returns it, with its amounts: the caller's own record. The envelope is
 * expense.get's, so the screens read either the same way (`meta.redacted` is always empty here: no
 * field is tagged).
 */
export const mineExpenseResultDto = withMeta(
  expenseDto.extend({
    amount: zDecimal,
    netTotal: zDecimal,
    vatTotal: zDecimal,
    total: zDecimal,
    costTotal: zDecimal.nullable(),
  }),
)
export type MineExpenseResultDto = z.infer<typeof mineExpenseResultDto>

// ---------------------------------------------------------------------------------------------------
// Owed to me (module purchases or expenses; every member)
// ---------------------------------------------------------------------------------------------------

/** `payable.mine`: what the business owes the caller and paid back, newest business day first. */
export const minePayableListInput = z
  .object({
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(DOCUMENT_PAGE_SIZE_MAX).default(DOCUMENT_PAGE_SIZE),
  })
  .prefault({})
export type MinePayableListInput = z.input<typeof minePayableListInput>

/** A payment of it that stands: the business paid the caller back. */
export const minePaymentDto = z.object({
  id: zUuid,
  businessDate: zBusinessDate,
  method: settlementMethodDto,
  amount: zDecimal,
})
export type MinePaymentDto = z.infer<typeof minePaymentDto>

/** A final purchase or expense the caller paid from their own money. */
export const minePayableDto = z.object({
  kind: payableKindDto,
  documentId: zUuid,
  /** `posted` (final); the list has no other. */
  status: z.union([documentStatusDto, expenseStatusDto]),
  businessDate: zBusinessDate,
  reference: z.string().nullable(),
  documentType: purchaseDocumentTypeDto,
  /** A purchase: its first two materials, as bought. An expense: what it was for, when it says. */
  itemNames: z.array(z.string()),
  /** An expense's category (as it is named now); null for a purchase. */
  categoryName: z.string().nullable(),
  /** A purchase's supplier (as named now), when it has one. */
  supplierName: z.string().nullable(),
  currency: z.string(),
  total: zDecimal,
  /** A purchase: its final returns and credit notes (their totals); 0 for an expense. */
  returned: zDecimal,
  /** Paid back so far: the payments that stand. */
  paid: zDecimal,
  /** total − returned − paid, never below zero: what the business still owes the caller for it. */
  outstanding: zDecimal,
  /** The payments that stand, newest first. */
  payments: z.array(minePaymentDto),
})
export type MinePayableDto = z.infer<typeof minePayableDto>

export const minePayableListDto = z.object({
  /** The business's currency. */
  currency: z.string(),
  /** Σ outstanding of every purchase and expense the caller paid (all pages). */
  outstanding: zDecimal,
  /** How many of them are still owed (all pages). */
  owedCount: z.int().nonnegative(),
  /** Σ paid back on them (all pages). */
  paidBack: zDecimal,
  /** This page, newest business day first. */
  items: z.array(minePayableDto),
  nextCursor: z.string().nullable(),
})
export type MinePayableListDto = z.infer<typeof minePayableListDto>
