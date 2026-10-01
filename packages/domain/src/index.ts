export { isUuid, newId } from './ids/id'
export { normalizeDigits } from './numbers/digits'
// Numbers: branded decimal strings, user input, the two rounding policies (D-032, D-033).
export { compareDecimal } from './numbers/decimal'
export {
  asCostAmount,
  asDecimal,
  asMoney,
  asPercent,
  asQuantity,
  asUnitCost,
  checkDecimal,
  COST_SCALE,
  DECIMAL_COLUMNS,
  QUANTITY_SCALE,
  type CostAmount,
  type DecimalCheckError,
  type DecimalKind,
  type DecimalKinds,
  type Money,
  type Percent,
  type Quantity,
  type UnitCost,
} from './numbers/kinds'
export { parseNumber, type ParseNumberError, type ParseNumberResult } from './numbers/parse'
export {
  CURRENCY_MINOR_UNITS,
  currencyMinorUnit,
  fitsCurrency,
  isCurrencyCode,
  roundCost,
  roundDocument,
  roundForDisplay,
  type CurrencyCode,
} from './numbers/rounding'
// Document line maths: discount before VAT, per-line rounding, totals as sums of the lines.
export {
  computeLine,
  lineError,
  type LineAmounts,
  type LineDiscount,
  type LineError,
  type LineInput,
} from './documents/line'
export { documentTotals, type DocumentTotals } from './documents/totals'
// Purchases: document discount and delivery split by line net, VAT in or out of cost (D-114 rule 4).
export {
  computePurchase,
  purchaseError,
  type PurchaseAmounts,
  type PurchaseDeliveryLineInput,
  type PurchaseError,
  type PurchaseErrorCode,
  type PurchaseInput,
  type PurchaseLineAmounts,
  type PurchaseLineInput,
  type PurchaseMaterialLineInput,
} from './documents/purchase'
export { proportionOf, splitByWeights, subtractDecimals, sumDecimals } from './documents/split'
// Units: standard units per dimension, material packs and cross factors, conversions (D-034).
export {
  BASE_UNITS,
  dimensionOf,
  DIMENSIONS,
  isDimension,
  isStandardUnit,
  STANDARD_UNITS,
  type Dimension,
  type StandardUnit,
} from './units/standard'
export {
  isValidFactor,
  validateMaterialUnits,
  type CrossFactor,
  type MaterialUnits,
  type MaterialUnitsError,
  type MaterialUnitsErrorCode,
  type PackDefinition,
  type UnitRef,
} from './units/materials'
export { costPerBaseUnit, fromBase, recipeLineCost, toBase, unitFactor } from './units/convert'
// Weighted-average cost: one average per material per business, in posting order (D-006).
export {
  EMPTY_WAC_STATE,
  replayWac,
  wacIssue,
  wacReceive,
  wacReverseReceipt,
  type WacIssueResult,
  type WacMovement,
  type WacReceipt,
  type WacReceiptResult,
  type WacReceiptStanding,
  type WacReplay,
  type WacReversalResult,
  type WacState,
  type WacStep,
} from './costing/wac'
export { costRatio } from './costing/cost-ratio'
// Product cost from its recipe: Σ base quantity × the material's average (D-115), never rounded;
// one unit sold is the total ÷ the recipe's yield (D-178).
export {
  costOfQty,
  costPerUnit,
  unitCostOf,
  rollUpRecipe,
  type CostBasis,
  type RecipeCost,
  type RecipeCostLine,
} from './costing/recipe'
// A product's whole cost for one unit sold (M2 Step 6): materials, the running-cost share by its
// price (D-202), the owner's time (D-119), and the margin on the price before VAT (D-121).
export {
  costCompleteFor,
  hoursAndMinutes,
  INCOMPLETE_REASONS,
  missesOnlyOptionalMaterials,
  ownerTimeCost,
  priceBeforeVat,
  productCost,
  RUNNING_SHARE_STATES,
  saleVatRate,
  STANDARD_VAT_RATE,
  type IncompleteReason,
  type MaterialsPart,
  type OwnerTimePart,
  type OwnerTimeState,
  type ProductCost,
  type ProductCostInput,
  type RunningShareState,
  type SalePrice,
} from './costing/product-cost'
// The business's running costs of a month, counted once (a quarter's or a year's bills over its
// months, D-203), and how they reach what it sells: by its price, the month's costs ÷ the month's
// sales (D-202).
export {
  COST_RATE_STATES,
  costPool,
  costRate,
  costShare,
  daysIn,
  daysRunIn,
  POOL_SOURCES,
  type CostPool,
  type CostRateState,
  type PoolCategory,
  type PoolExpense,
  type PoolPeriod,
  type PoolRunningCost,
  type PoolSource,
  type RunningCostsPart,
} from './costing/cost-share'
export {
  MATERIAL_UNIT_KINDS,
  PRODUCT_TYPES,
  VAT_CATEGORIES,
  type MaterialUnitKind,
  type ProductType,
  type VatCategory,
} from './catalog/keys'
export {
  ATTACHMENT_ENTITIES,
  defaultPricesIncludeVat,
  DOCUMENT_STATUSES,
  isOwedPaymentMethod,
  outstandingOf,
  overpaidOf,
  OWED_PAYMENT_METHODS,
  PAYMENT_METHODS,
  PURCHASE_AVERAGE_DAYS,
  PURCHASE_DOCUMENT_TYPES,
  PURCHASE_LINE_KINDS,
  PURCHASE_RETURN_KINDS,
  SETTLEMENT_METHODS,
  STOCK_MOVEMENT_KINDS,
  vatInCost,
  type AttachmentEntity,
  type DocumentStatus,
  type OwedPaymentMethod,
  type PaymentMethod,
  type PurchaseDocumentType,
  type PurchaseLineKind,
  type PurchaseReturnKind,
  type SettlementMethod,
  type StockMovementKind,
  type VatInCostInput,
} from './purchasing/keys'
// Expenses and running costs (M2 Step 5): statuses and approval, amounts, monthly amounts.
export {
  EXPENSE_STATUSES,
  monthlyAmount,
  monthlyTotal,
  RUNNING_COST_FREQUENCIES,
  runningCostActiveOn,
  STARTER_COST_CATEGORIES,
  type ExpenseStatus,
  type RunningCostFrequency,
  type StarterCostCategory,
} from './expenses/keys'
export {
  addMonths,
  BILLED_NEXT_MONTH_CATEGORIES,
  BUSINESS_MONTH_PATTERN,
  defaultPeriodMonth,
  firstDayOf,
  firstOpenMonth,
  monthOf,
  PERIOD_MONTHS_AFTER,
  PERIOD_MONTHS_BEFORE,
  periodMonthAllowed,
  periodMonthClosed,
  type BusinessMonth,
} from './expenses/period'
export {
  computeExpense,
  expenseError,
  type ExpenseAmounts,
  type ExpenseErrorCode,
  type ExpenseInput,
} from './expenses/amounts'
export {
  EXPENSE_ACTIONS,
  expenseActions,
  expenseTransition,
  type ExpenseAction,
  type ExpenseActionContext,
  type ExpenseRefusal,
  type ExpenseTransition,
} from './expenses/approval'
// Names of catalog records compared the way people read them (duplicates and "did you mean").
export { matchNames, nameKey, type NameMatches } from './catalog/names'
export { parseTrn, TRN_LENGTH, type TrnError, type TrnResult } from './business/trn'
export { businessDisplayName, type BusinessNames } from './business/display-name'
export {
  AUDIT_ACTIONS,
  BUSINESS_TYPES,
  CAPABILITY_SOURCES,
  INVITATION_STATUSES,
  isLocale,
  isTerminologyProfile,
  LOCALES,
  MEMBER_KINDS,
  MEMBER_STATUSES,
  OWNER_TEMPLATE_KEY,
  PERMISSION_EFFECTS,
  TERMINOLOGY_PROFILES,
  type AuditAction,
  type BusinessType,
  type CapabilitySource,
  type InvitationStatus,
  type Locale,
  type MemberKind,
  type MemberStatus,
  type PermissionEffect,
  type TerminologyProfile,
} from './tenancy/keys'
export {
  can,
  canAccessLocation,
  isPermissionKey,
  isSensitivityCategory,
  resolveEffective,
  resolveLocationScope,
  SENSITIVITY_CATEGORIES,
  SENSITIVITY_PERMISSION_KEYS,
  SENSITIVITY_REQUIRES,
  sensitivityPermissionKey,
  visibleCategories,
  type EffectivePermissions,
  type LocationScope,
  type PermissionOverride,
  type ResolveEffectiveInput,
  type SensitivityCategory,
  type SensitivityPermissionKey,
} from './permissions'
