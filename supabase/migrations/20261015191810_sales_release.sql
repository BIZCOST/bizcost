-- BizCost: Release A (M3 Step 6): Sales, Orders, Customers, Payments and Reports are released.
--
-- Their keys are final: the template defaults below are the plan's Q10 table, as role-templates.ts in
-- @bizcost/modules has them (sales_security, reports_access, sale_imports_security and
-- orders_security each added theirs when their build started, D-124). This migration states them all
-- once more for the existing template roles (Admin holds every key): a role that lacks one of them
-- gets it, and a key its owner took off (a soft-deleted row) stays off, as before. Nothing is
-- expected to change; it makes the release's keys hold whatever order the steps' migrations ran in.
--
-- Every member then gets a new permissions_version: the release changes what they reach (the
-- sections, the phone's tabs, "+", what the Roles editor offers, closing the books with Sales or
-- Orders on, D-201), so open apps read business.context again (x-permissions-version).

with defaults (template_key, permission_key) as (
  values
    ('admin', 'sales.documents.view'),
    ('admin', 'sales.documents.manage'),
    ('admin', 'sales.documents.post'),
    ('admin', 'sales.documents.reverse'),
    ('admin', 'sales.channels.manage'),
    ('admin', 'sales.imports.manage'),
    ('admin', 'orders.documents.view'),
    ('admin', 'orders.documents.manage'),
    ('admin', 'orders.documents.deliver'),
    ('admin', 'orders.documents.reverse'),
    ('admin', 'customers.items.view'),
    ('admin', 'customers.items.manage'),
    ('admin', 'payments.customers.view'),
    ('admin', 'payments.customers.record'),
    ('admin', 'reports.sales.view'),
    ('admin', 'reports.profit.view'),
    ('manager', 'sales.documents.view'),
    ('manager', 'sales.documents.manage'),
    ('manager', 'sales.documents.post'),
    ('manager', 'sales.documents.reverse'),
    ('manager', 'sales.channels.manage'),
    ('manager', 'sales.imports.manage'),
    ('manager', 'orders.documents.view'),
    ('manager', 'orders.documents.manage'),
    ('manager', 'orders.documents.deliver'),
    ('manager', 'orders.documents.reverse'),
    ('manager', 'customers.items.view'),
    ('manager', 'customers.items.manage'),
    ('manager', 'payments.customers.view'),
    ('manager', 'payments.customers.record'),
    ('manager', 'reports.sales.view'),
    ('manager', 'reports.profit.view'),
    ('accountant', 'sales.documents.view'),
    ('accountant', 'orders.documents.view'),
    ('accountant', 'customers.items.view'),
    ('accountant', 'payments.customers.view'),
    ('accountant', 'payments.customers.record'),
    ('accountant', 'reports.sales.view'),
    ('accountant', 'reports.profit.view'),
    ('sales', 'sales.documents.view'),
    ('sales', 'sales.documents.manage'),
    ('sales', 'sales.documents.post'),
    ('sales', 'orders.documents.view'),
    ('sales', 'orders.documents.manage'),
    ('sales', 'orders.documents.deliver'),
    ('sales', 'customers.items.view'),
    ('sales', 'customers.items.manage'),
    ('sales', 'payments.customers.view'),
    ('sales', 'payments.customers.record'),
    ('sales', 'reports.sales.view'),
    ('supervisor', 'sales.documents.view'),
    ('supervisor', 'sales.documents.manage'),
    ('supervisor', 'sales.documents.post'),
    ('supervisor', 'orders.documents.view'),
    ('supervisor', 'orders.documents.manage'),
    ('supervisor', 'orders.documents.deliver'),
    ('supervisor', 'customers.items.view'),
    ('supervisor', 'customers.items.manage'),
    ('supervisor', 'reports.sales.view'),
    ('employee', 'sales.documents.manage'),
    ('employee', 'sales.documents.post'),
    ('employee', 'orders.documents.manage'),
    ('employee', 'orders.documents.deliver'),
    ('employee', 'customers.items.manage')
)
insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
select app.uuid_v7(), r.business_id, r.id, d.permission_key, r.created_by
from app.roles r
join defaults d on d.template_key = r.template_key
where r.deleted_at is null
on conflict (business_id, role_id, permission_key) do nothing;

update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null;
