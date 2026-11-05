/**
 * Most procedure calls one HTTP request may batch. The server rejects larger batches with 400
 * (validation) before running any procedure; clients set their batch link's `maxItems` to this value.
 */
export const API_MAX_BATCH_SIZE = 20

/**
 * Longest URL a batch of queries may make; a longer batch is split into several requests. Hosts refuse
 * long URLs (Vercel at 14 KB, D-353), and a batch of 20 queries with Arabic filters, percent-encoded,
 * can pass that.
 */
export const API_MAX_URL_LENGTH = 8000
