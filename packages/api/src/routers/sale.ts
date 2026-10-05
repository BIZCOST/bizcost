import {
  catalogIdInput,
  channelListInput,
  correctSaleInput,
  createChannelInput,
  createSaleInput,
  daySheetDto,
  daySheetInput,
  fillDeliveryCostInput,
  okDto,
  saleIdInput,
  saleListDto,
  saleListInput,
  saleResultDto,
  salesChannelListDto,
  salesChannelResultDto,
  saleVersionInput,
  updateChannelInput,
  updateSaleInput,
} from '@bizcost/contracts'
import {
  correctSale,
  createSale,
  daySheet,
  discardSale,
  fillDeliveryCost,
  getSale,
  listSales,
  postSale,
  reverseSale,
  updateSale,
} from '../services/sales'
import {
  archiveChannel,
  createChannel,
  listChannels,
  unarchiveChannel,
  updateChannel,
} from '../services/sales-channels'
import {
  businessProcedure,
  requireAnyPermission,
  requireModule,
  requirePermission,
  router,
} from '../trpc'

/**
 * Sales (services/sales.ts; M3 Step 2): module `sales` (planned until Release A, so served only under
 * the dev-only preview, D-125). Reading needs a sales key: sales.documents.view sees every sale, and a
 * member who only enters (.manage) sees their own (the service filters, D-181). .manage saves and
 * discards drafts, .post finalizes, .reverse reverses, .reverse with .manage corrects. The day sheet
 * lists products, so it also needs Products & Services on. Outputs are withMeta(): costs are removed
 * for members without data.cost.view.
 */
const salesModule = businessProcedure.use(requireModule('sales'))
const readSales = salesModule.use(
  requireAnyPermission('sales.documents.view', 'sales.documents.manage', 'sales.documents.post'),
)
const manageSales = salesModule.use(requirePermission('sales.documents.manage'))
const postSales = salesModule.use(requirePermission('sales.documents.post'))
const reverseSales = salesModule.use(requirePermission('sales.documents.reverse'))

export const saleRouter = router({
  /** `sale.list`: newest business day first, filters and a cursor; own sales only without .view. */
  list: readSales
    .input(saleListInput)
    .output(saleListDto)
    .query(({ ctx, input }) => listSales(ctx, input)),
  /** `sale.get`: with its lines and, once finalized, their cost. */
  get: readSales
    .input(saleIdInput)
    .output(saleResultDto)
    .query(({ ctx, input }) => getSale(ctx, input)),
  /**
   * `sale.daySheet`: the caller's Today's sales for a day, a channel and a branch, with the branch's
   * products and their last prices (Q10).
   */
  daySheet: manageSales
    .use(requireModule('products'))
    .input(daySheetInput)
    .output(daySheetDto)
    .query(({ ctx, input }) => daySheet(ctx, input)),
  /** `sale.create`: a draft, idempotent on the client's id. */
  create: manageSales
    .input(createSaleInput)
    .output(saleResultDto)
    .mutation(({ ctx, input }) => createSale(ctx, input)),
  /** `sale.update`: the whole draft, `version` as read. */
  update: manageSales
    .input(updateSaleInput)
    .output(saleResultDto)
    .mutation(({ ctx, input }) => updateSale(ctx, input)),
  /** `sale.discard`: a draft is taken out; a finalized sale never is. */
  discard: manageSales
    .input(saleVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardSale(ctx, input)),
  /** `sale.post`: finalized with the cost of what was sold frozen on its day. Idempotent. */
  post: postSales
    .input(saleVersionInput)
    .output(saleResultDto)
    .mutation(({ ctx, input }) => postSale(ctx, input)),
  /** `sale.reverse`: as if never finalized (a closed day's on the first open day). Idempotent. */
  reverse: reverseSales
    .input(saleIdInput)
    .output(saleResultDto)
    .mutation(({ ctx, input }) => reverseSale(ctx, input)),
  /**
   * `sale.correct`: reverse, and a copy as a new draft (`newId`). Idempotent on `newId`. It reverses
   * and opens a draft, so it needs .reverse and .manage.
   */
  correct: reverseSales
    .use(requirePermission('sales.documents.manage'))
    .input(correctSaleInput)
    .output(saleResultDto)
    .mutation(({ ctx, input }) => correctSale(ctx, input)),
  /**
   * `sale.fillDeliveryCost`: what a finalized sale's delivery actually cost, once, while missing
   * (.manage and the costs switch, D-230).
   */
  fillDeliveryCost: manageSales
    .input(fillDeliveryCostInput)
    .output(saleResultDto)
    .mutation(({ ctx, input }) => fillDeliveryCost(ctx, input)),
})

/**
 * Sales channels (services/sales-channels.ts): module `sales`. Any sales key lists them (a sale names
 * one); sales.channels.manage adds, changes, archives and brings one back. The commission % is a
 * `cost` (removed without data.cost.view; set only with it).
 */
const channelsModule = salesModule
const listChannelsAccess = channelsModule.use(
  requireAnyPermission(
    'sales.documents.view',
    'sales.documents.manage',
    'sales.documents.post',
    'sales.channels.manage',
  ),
)
const manageChannels = channelsModule.use(requirePermission('sales.channels.manage'))

export const channelRouter = router({
  /** `channel.list`: by name; active ones by default. */
  list: listChannelsAccess
    .input(channelListInput)
    .output(salesChannelListDto)
    .query(({ ctx, input }) => listChannels(ctx, input)),
  /** `channel.create`: idempotent on the client's id. */
  create: manageChannels
    .input(createChannelInput)
    .output(salesChannelResultDto)
    .mutation(({ ctx, input }) => createChannel(ctx, input)),
  /** `channel.update`: the whole channel, `version` as read. */
  update: manageChannels
    .input(updateChannelInput)
    .output(salesChannelResultDto)
    .mutation(({ ctx, input }) => updateChannel(ctx, input)),
  /** `channel.archive`: never a delete; the last active channel stays (LAST_CHANNEL). */
  archive: manageChannels
    .input(catalogIdInput)
    .output(salesChannelResultDto)
    .mutation(({ ctx, input }) => archiveChannel(ctx, input)),
  /** `channel.unarchive`. */
  unarchive: manageChannels
    .input(catalogIdInput)
    .output(salesChannelResultDto)
    .mutation(({ ctx, input }) => unarchiveChannel(ctx, input)),
})
