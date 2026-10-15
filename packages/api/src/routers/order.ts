import {
  cancelOrderInput,
  createOrderInput,
  deliverOrderInput,
  orderIdInput,
  orderListDto,
  orderListInput,
  orderResultDto,
  updateOrderInput,
} from '@bizcost/contracts'
import {
  cancelOrder,
  createOrder,
  deliverOrder,
  getOrder,
  listOrders,
  undoDelivery,
  updateOrder,
} from '../services/orders'
import {
  businessProcedure,
  requireAnyPermission,
  requireModule,
  requirePermission,
  router,
} from '../trpc'

/**
 * Orders (services/orders.ts; M3 Step 5): module `orders` (planned until Release A, so served only
 * under the dev-only preview, D-125). orders.documents.view sees every order; a member who only
 * enters (.manage) or delivers (.deliver) sees their own (the service filters, D-181, D-214). .manage
 * creates, changes and cancels pending orders; .deliver delivers them (their sale is posted);
 * .reverse undoes a delivery. Outputs are withMeta(): the delivery cost and the order's profit are
 * removed for members without the costs switch.
 */
const ordersModule = businessProcedure.use(requireModule('orders'))
const readOrders = ordersModule.use(
  requireAnyPermission(
    'orders.documents.view',
    'orders.documents.manage',
    'orders.documents.deliver',
  ),
)
const manageOrders = ordersModule.use(requirePermission('orders.documents.manage'))
const deliverOrders = ordersModule.use(requirePermission('orders.documents.deliver'))
const reverseOrders = ordersModule.use(requirePermission('orders.documents.reverse'))

export const orderRouter = router({
  /** `order.list`: pending first by due day, then delivered and cancelled, newest first. */
  list: readOrders
    .input(orderListInput)
    .output(orderListDto)
    .query(({ ctx, input }) => listOrders(ctx, input)),
  /** `order.get`: with its lines, payments, refunds and (with costs) its profit. */
  get: readOrders
    .input(orderIdInput)
    .output(orderResultDto)
    .query(({ ctx, input }) => getOrder(ctx, input)),
  /** `order.create`: numbered #1001…, idempotent on the client's id, with its deposit if paid now. */
  create: manageOrders
    .input(createOrderInput)
    .output(orderResultDto)
    .mutation(({ ctx, input }) => createOrder(ctx, input)),
  /** `order.update`: a pending order, whole, `version` as read. */
  update: manageOrders
    .input(updateOrderInput)
    .output(orderResultDto)
    .mutation(({ ctx, input }) => updateOrder(ctx, input)),
  /** `order.cancel`: a pending order; nothing in the books changes. Idempotent. */
  cancel: manageOrders
    .input(cancelOrderInput)
    .output(orderResultDto)
    .mutation(({ ctx, input }) => cancelOrder(ctx, input)),
  /** `order.deliver`: it counts as a sale on its delivery day, its cost frozen then. Idempotent. */
  deliver: deliverOrders
    .input(deliverOrderInput)
    .output(orderResultDto)
    .mutation(({ ctx, input }) => deliverOrder(ctx, input)),
  /** `order.undoDelivery`: its sale reversed, the order pending again. Idempotent. */
  undoDelivery: reverseOrders
    .input(orderIdInput)
    .output(orderResultDto)
    .mutation(({ ctx, input }) => undoDelivery(ctx, input)),
})
