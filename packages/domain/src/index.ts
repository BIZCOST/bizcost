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
  DOCUMENT_STATUSES,
  PAYMENT_METHODS,
  PURCHASE_AVERAGE_DAYS,
  PURCHASE_DOCUMENT_TYPES,
  PURCHASE_LINE_KINDS,
  PURCHASE_RETURN_KINDS,
  STOCK_MOVEMENT_KINDS,
  vatInCost,
  type AttachmentEntity,
  type DocumentStatus,
  type PaymentMethod,
  type PurchaseDocumentType,
  type PurchaseLineKind,
  type PurchaseReturnKind,
  type StockMovementKind,
  type VatInCostInput,
} from './purchasing/keys'
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
