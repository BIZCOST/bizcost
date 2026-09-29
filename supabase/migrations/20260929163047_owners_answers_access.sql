-- BizCost: the owner's answers of 2026-09-29 for the Employee template (D-179, D-180).
--
-- A2: an employee sees what goes into each product (the quantities; costs stay locked): the Employee
-- template now holds products.recipes.view and the keys it needs (PERMISSION_NEEDS, D-155):
-- products.items.view (every template has it) and materials.items.view.
-- A3: an employee enters expenses and sends them for approval: expenses.documents.view and
-- expenses.documents.manage (drafts, receipts, sending for approval), never approve, post, reverse or
-- payments.
--
-- Smart Setup copies the role templates of @bizcost/modules (role-templates.ts) into every new
-- business; the Employee roles businesses already have get the same new keys here, once (as
-- recipes_security and expenses_security did). A key is added only where every key it needs ends up
-- held, so no role breaks PERMISSION_NEEDS (a key the owner had taken off stays off: `on conflict do
-- nothing` keeps a soft-deleted row, and whatever needs it is then left out too). Every member holding
-- a changed role gets a new permissions_version, so open apps reload their access. No sensitive key
-- is added: costs and supplier prices stay hidden from the template.

-- First the keys that need nothing new (products.items.view is already there, D-124).
with defaults (permission_key) as (
  values ('products.items.view'), ('materials.items.view'), ('expenses.documents.view')
),
added as (
  insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
  select app.uuid_v7(), r.business_id, r.id, d.permission_key, r.created_by
  from app.roles r
  cross join defaults d
  where r.template_key = 'employee'
    and r.deleted_at is null
  on conflict (business_id, role_id, permission_key) do nothing
  returning business_id, role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select distinct a.business_id, a.role_id from added a);

-- Then the keys that need them: each only where its needs are live on the role.
with dependants (permission_key, needs) as (
  values
    ('products.recipes.view', array['products.items.view', 'materials.items.view']),
    ('expenses.documents.manage', array['expenses.documents.view'])
),
added as (
  insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
  select app.uuid_v7(), r.business_id, r.id, d.permission_key, r.created_by
  from app.roles r
  cross join dependants d
  where r.template_key = 'employee'
    and r.deleted_at is null
    and (
      select count(*)
      from app.role_permissions held
      where held.business_id = r.business_id
        and held.role_id = r.id
        and held.deleted_at is null
        and held.permission_key = any (d.needs)
    ) = cardinality(d.needs)
  on conflict (business_id, role_id, permission_key) do nothing
  returning business_id, role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select distinct a.business_id, a.role_id from added a);
