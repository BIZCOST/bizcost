import {
  addCountLinesInput,
  countIdInput,
  countLineResultDto,
  countLineVersionInput,
  countListDto,
  countListInput,
  countResultDto,
  countReviewDto,
  countVersionInput,
  okDto,
  saveCountLineInput,
  startCountInput,
  stockCardDto,
  stockCardInput,
  stockListDto,
  stockListInput,
  stockUntrackedDto,
  stockUntrackedInput,
} from '@bizcost/contracts'
import {
  addCountLines,
  clearCountLine,
  discardCount,
  finalizeCount,
  getCount,
  listCounts,
  removeCountLine,
  reverseCount,
  reviewCount,
  saveCountLine,
  startCount,
} from '../services/counts'
import { listStock, listUntracked, stockCard } from '../services/stock-on-hand'
import {
  businessProcedure,
  requireAnyPermission,
  requireCapability,
  requireModule,
  requirePermission,
  router,
} from '../trpc'

/**
 * Stock (services/stock-on-hand.ts, services/counts.ts; M4 Step 2; planned until Release A of M4,
 * served before that only under the dev-only preview, D-125): module `inventory` and the keeps_stock
 * capability, then inventory.stock.view to see stock on hand, the stock card and finalized counts;
 * .counts.enter to fill a draft count's lines (blind, Q6); .counts.manage to start tracking, start,
 * change, review, finalize, discard and reverse counts. A member limited to some branches sees and
 * counts only there (the services check it). Outputs with values are withMeta(): stock values,
 * averages and a difference's value are removed for members without data.cost.view.
 */
const inventoryModule = businessProcedure
  .use(requireModule('inventory'))
  .use(requireCapability('keeps_stock'))
const viewStock = inventoryModule.use(requirePermission('inventory.stock.view'))
const manageCounts = inventoryModule.use(requirePermission('inventory.counts.manage'))
const readCounts = inventoryModule.use(
  requireAnyPermission('inventory.stock.view', 'inventory.counts.enter', 'inventory.counts.manage'),
)
const enterCounts = inventoryModule.use(
  requireAnyPermission('inventory.counts.enter', 'inventory.counts.manage'),
)

export const stockRouter = router({
  /** `stock.list`: tracked materials by name, on hand in each of the caller's branches. */
  list: viewStock
    .input(stockListInput)
    .output(stockListDto)
    .query(({ ctx, input }) => listStock(ctx, input)),
  /** `stock.untracked`: live materials not tracked yet, to start tracking them (counts.manage). */
  untracked: manageCounts
    .input(stockUntrackedInput)
    .output(stockUntrackedDto)
    .query(({ ctx, input }) => listUntracked(ctx, input)),
  /** `stock.card`: a tracked material's movements, newest business day first. */
  card: viewStock
    .input(stockCardInput)
    .output(stockCardDto)
    .query(({ ctx, input }) => stockCard(ctx, input)),
})

export const countRouter = router({
  /**
   * `count.list`: newest business day first; drafts for whoever fills or manages counts, finalized
   * and reversed ones for whoever sees stock.
   */
  list: readCounts
    .input(countListInput)
    .output(countListDto)
    .query(({ ctx, input }) => listCounts(ctx, input)),
  /** `count.get`: with its lines in the caller's branches (blind without counts.manage). */
  get: readCounts
    .input(countIdInput)
    .output(countResultDto)
    .query(({ ctx, input }) => getCount(ctx, input)),
  /** `count.review`: expected against counted, before finalizing. */
  review: manageCounts
    .input(countIdInput)
    .output(countReviewDto)
    .query(({ ctx, input }) => reviewCount(ctx, input)),
  /** `count.start`: a draft first count or count, idempotent on the client's id. */
  start: manageCounts
    .input(startCountInput)
    .output(countResultDto)
    .mutation(({ ctx, input }) => startCount(ctx, input)),
  /** `count.saveLine`: what was counted on one line, its `version` as read. */
  saveLine: enterCounts
    .input(saveCountLineInput)
    .output(countLineResultDto)
    .mutation(({ ctx, input }) => saveCountLine(ctx, input)),
  /** `count.clearLine`: "count it again". */
  clearLine: manageCounts
    .input(countLineVersionInput)
    .output(countLineResultDto)
    .mutation(({ ctx, input }) => clearCountLine(ctx, input)),
  /** `count.addLines`: materials added to a draft. */
  addLines: manageCounts
    .input(addCountLinesInput)
    .output(countResultDto)
    .mutation(({ ctx, input }) => addCountLines(ctx, input)),
  /** `count.removeLine`: a line taken off a draft. */
  removeLine: manageCounts
    .input(countLineVersionInput)
    .output(countResultDto)
    .mutation(({ ctx, input }) => removeCountLine(ctx, input)),
  /** `count.finalize`: the stock is set; idempotent. */
  finalize: manageCounts
    .input(countVersionInput)
    .output(countResultDto)
    .mutation(({ ctx, input }) => finalizeCount(ctx, input)),
  /** `count.discard`: a draft is taken out; a finalized count never is. */
  discard: manageCounts
    .input(countVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardCount(ctx, input)),
  /** `count.reverse`: as if never finalized (a closed day's on the first open day). Idempotent. */
  reverse: manageCounts
    .input(countIdInput)
    .output(countResultDto)
    .mutation(({ ctx, input }) => reverseCount(ctx, input)),
})
