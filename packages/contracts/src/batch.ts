/**
 * Most procedure calls one HTTP request may batch. The server rejects larger batches with 400
 * (validation) before running any procedure; clients set their batch link's `maxItems` to this value.
 */
export const API_MAX_BATCH_SIZE = 20
