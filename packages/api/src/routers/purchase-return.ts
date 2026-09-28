import {
  createPurchaseReturnInput,
  documentIdInput,
  documentVersionInput,
  okDto,
  purchaseReturnListDto,
  purchaseReturnListInput,
  purchaseReturnResultDto,
  updatePurchaseReturnInput,
} from '@bizcost/contracts'
import {
  createReturn,
  discardReturn,
  getReturn,
  listReturns,
  postReturn,
  reverseReturn,
  updateReturn,
} from '../services/purchase-returns'
import { router } from '../trpc'
import { managePurchases, postPurchases, reversePurchases, viewPurchases } from './purchase'

/**
 * Supplier returns and credit notes (services/purchase-returns.ts; D-120): the purchases module and
 * its keys, as for purchases.
 */
export const purchaseReturnRouter = router({
  /** `purchaseReturn.list`: newest business day first; by purchase, kind and status. */
  list: viewPurchases
    .input(purchaseReturnListInput)
    .output(purchaseReturnListDto)
    .query(({ ctx, input }) => listReturns(ctx, input)),
  /** `purchaseReturn.get`. */
  get: viewPurchases
    .input(documentIdInput)
    .output(purchaseReturnResultDto)
    .query(({ ctx, input }) => getReturn(ctx, input)),
  /** `purchaseReturn.create`: a draft for a posted purchase, idempotent on the client's id. */
  create: managePurchases
    .input(createPurchaseReturnInput)
    .output(purchaseReturnResultDto)
    .mutation(({ ctx, input }) => createReturn(ctx, input)),
  /** `purchaseReturn.update`: the whole draft, `version` as read. */
  update: managePurchases
    .input(updatePurchaseReturnInput)
    .output(purchaseReturnResultDto)
    .mutation(({ ctx, input }) => updateReturn(ctx, input)),
  /** `purchaseReturn.discard`: a draft is taken out. */
  discard: managePurchases
    .input(documentVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardReturn(ctx, input)),
  /** `purchaseReturn.post`: goods out at the price paid, or the credit off their cost. Idempotent. */
  post: postPurchases
    .input(documentVersionInput)
    .output(purchaseReturnResultDto)
    .mutation(({ ctx, input }) => postReturn(ctx, input)),
  /** `purchaseReturn.reverse`: as if never posted. Idempotent. */
  reverse: reversePurchases
    .input(documentIdInput)
    .output(purchaseReturnResultDto)
    .mutation(({ ctx, input }) => reverseReturn(ctx, input)),
})
