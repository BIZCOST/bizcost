// Limits of Customers, Orders and customer payments (M3 Step 5), shared by the API (dto/customers.ts,
// dto/orders.ts, dto/customer-payments.ts) and the app forms. No Zod here, so a client that needs only
// the numbers does not bundle the API schemas. The database CHECKs hold the same lengths (packages/db
// schema/customers.ts, schema/orders.ts).

/** Longest customer name. */
export const CUSTOMER_NAME_MAX_LENGTH = 100

/** Longest customer phone number, as typed (as a supplier's). */
export const CUSTOMER_PHONE_MAX_LENGTH = 30

/** Longest customer email. */
export const CUSTOMER_EMAIL_MAX_LENGTH = 254

/** Longest trade licence number of a business or government customer. */
export const CUSTOMER_LICENCE_MAX_LENGTH = 50

/** Longest address line, and city. */
export const CUSTOMER_ADDRESS_MAX_LENGTH = 200
export const CUSTOMER_CITY_MAX_LENGTH = 100

/** Customers per page of `customer.list`, and the most a client may ask for. */
export const CUSTOMER_PAGE_SIZE = 50
export const CUSTOMER_PAGE_SIZE_MAX = 100

/** Customers a picker (`customer.pick`) or "Did you mean" (`customer.similar`) lists at most. */
export const CUSTOMER_PICK_MAX = 20

/** Longest customer's reference on an order (their LPO number). */
export const ORDER_CUSTOMER_REF_MAX_LENGTH = 100

/** Longest reason given when an order is cancelled. */
export const ORDER_CANCEL_REASON_MAX_LENGTH = 500

/** Orders per page of `order.list`, and the most a client may ask for. */
export const ORDER_PAGE_SIZE = 50
export const ORDER_PAGE_SIZE_MAX = 100

/**
 * What customers owe (`receivable.list`): customers per page, and the orders and sales listed for each
 * (the oldest first; the rest are counted).
 */
export const RECEIVABLE_PAGE_SIZE = 25
export const RECEIVABLE_DOCUMENTS_MAX = 50

/** Customer payments per page of `customerPayment.list` for a customer. */
export const CUSTOMER_PAYMENT_PAGE_SIZE = 50

/** Documents one "Pay several at once" (`customerPayment.recordMany`) may pay. */
export const PAY_MANY_DOCUMENTS_MAX = 50

/** Lines one refund may take back (a sale's lines at most). */
export const REFUND_LINES_MAX = 300
