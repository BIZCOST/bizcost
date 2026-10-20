-- BizCost: Release B (M3 Step 9): Quotations and Invoices are released.
--
-- Their keys are final: the template defaults below are the plan's Q10 table, as role-templates.ts in
-- @bizcost/modules has them (quotations_security added the quotations keys and "Manage documents"
-- (Settings → Documents) when the build of Quotations started, invoices_security the invoices keys
-- when Invoices' did, D-124). This migration states them all once more for the existing template
-- roles (Admin holds every key): a role that lacks one of them gets it, and a key its owner took off
-- (a soft-deleted row) stays off, as before. Nothing is expected to change; it makes the release's
-- keys hold whatever order the steps' migrations ran in.
--
-- Every member then gets a new permissions_version: the release changes what they reach (the
-- sections, the phone's tabs (Invoices in the Sales place of a business that invoices without
-- orders), "+" with New quotation and New invoice, what the Roles editor offers, Settings → Documents,
-- the customers' statements), so open apps read business.context again (x-permissions-version).

with defaults (template_key, permission_key) as (
  values
    ('admin', 'settings.documents.manage'),
    ('admin', 'quotations.documents.view'),
    ('admin', 'quotations.documents.manage'),
    ('admin', 'quotations.documents.decide'),
    ('admin', 'invoices.documents.view'),
    ('admin', 'invoices.documents.manage'),
    ('admin', 'invoices.documents.issue'),
    ('admin', 'invoices.documents.credit'),
    ('manager', 'quotations.documents.view'),
    ('manager', 'quotations.documents.manage'),
    ('manager', 'quotations.documents.decide'),
    ('manager', 'invoices.documents.view'),
    ('manager', 'invoices.documents.manage'),
    ('manager', 'invoices.documents.issue'),
    ('manager', 'invoices.documents.credit'),
    ('accountant', 'quotations.documents.view'),
    ('accountant', 'invoices.documents.view'),
    ('accountant', 'invoices.documents.manage'),
    ('accountant', 'invoices.documents.issue'),
    ('accountant', 'invoices.documents.credit'),
    ('sales', 'quotations.documents.view'),
    ('sales', 'quotations.documents.manage'),
    ('sales', 'quotations.documents.decide'),
    ('sales', 'invoices.documents.view'),
    ('sales', 'invoices.documents.manage')
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
