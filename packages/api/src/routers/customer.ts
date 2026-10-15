import {
  catalogIdInput,
  createCustomerInput,
  customerDto,
  customerListDto,
  customerListInput,
  customerPickDto,
  customerPickInput,
  customerSimilarDto,
  customerSimilarInput,
  updateCustomerInput,
} from '@bizcost/contracts'
import {
  archiveCustomer,
  createCustomer,
  getCustomer,
  listCustomers,
  pickCustomers,
  similarCustomers,
  unarchiveCustomer,
  updateCustomer,
} from '../services/customers'
import {
  businessProcedure,
  requireAnyPermission,
  requireModule,
  requirePermission,
  router,
} from '../trpc'

/**
 * Customers (services/customers.ts; M3 Step 5): module `customers` (planned until Release A, so
 * served only under the dev-only preview, D-125). customers.items.view lists and reads them with their
 * details; .manage adds them, and with .view changes, archives and brings them back. A member who may
 * name a customer (adding customers, entering orders or sales, recording customer payments) picks them
 * through `pick` and `similar`: with customers.items.view the whole phone, without it the name and the
 * phone's last 4 digits only (Q2, Q10). Nothing here is a redaction category.
 */
const customersModule = businessProcedure.use(requireModule('customers'))
const viewCustomers = customersModule.use(requirePermission('customers.items.view'))
const addCustomers = customersModule.use(requirePermission('customers.items.manage'))
const changeCustomers = viewCustomers.use(requirePermission('customers.items.manage'))
const pickers = customersModule.use(
  requireAnyPermission(
    'customers.items.view',
    'customers.items.manage',
    'orders.documents.manage',
    'sales.documents.manage',
    'payments.customers.record',
  ),
)

export const customerRouter = router({
  /** `customer.list`: by name (names may repeat), with a search in the name or the phone. */
  list: viewCustomers
    .input(customerListInput)
    .output(customerListDto)
    .query(({ ctx, input }) => listCustomers(ctx, input)),
  /** `customer.get`. */
  get: viewCustomers
    .input(catalogIdInput)
    .output(customerDto)
    .query(({ ctx, input }) => getCustomer(ctx, input)),
  /** `customer.pick`: a picker's customers (masked without customers.items.view). */
  pick: pickers
    .input(customerPickInput)
    .output(customerPickDto)
    .query(({ ctx, input }) => pickCustomers(ctx, input)),
  /** `customer.similar`: "Did you mean Ahmed · 050…?" before a new one is added. */
  similar: pickers
    .input(customerSimilarInput)
    .output(customerSimilarDto)
    .query(({ ctx, input }) => similarCustomers(ctx, input)),
  /** `customer.create`: idempotent on the client's id; a name may repeat. */
  create: addCustomers
    .input(createCustomerInput)
    .output(customerDto)
    .mutation(({ ctx, input }) => createCustomer(ctx, input)),
  /** `customer.update`: the whole record, `version` as read. */
  update: changeCustomers
    .input(updateCustomerInput)
    .output(customerDto)
    .mutation(({ ctx, input }) => updateCustomer(ctx, input)),
  /** `customer.archive`: never a delete. */
  archive: changeCustomers
    .input(catalogIdInput)
    .output(customerDto)
    .mutation(({ ctx, input }) => archiveCustomer(ctx, input)),
  /** `customer.unarchive`. */
  unarchive: changeCustomers
    .input(catalogIdInput)
    .output(customerDto)
    .mutation(({ ctx, input }) => unarchiveCustomer(ctx, input)),
})
