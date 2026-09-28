-- BizCost: Materials and Products & Services (M2 Step 2). Hand-written part of the catalog tables:
-- row level security, the touch and audit triggers, and the new permission keys for the roles that
-- businesses already have. See docs/DATA_MODEL.md §6 and D-121–D-125.
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE. The grants
-- come from the default privileges of schema app (SELECT/INSERT/UPDATE/DELETE for bizcost_api). The API
-- never deletes these rows: records are archived, units and locations taken out of a list are
-- soft-deleted.

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.materials');
select app.apply_tenant_rls('app.material_units');
select app.apply_tenant_rls('app.products_services');
select app.apply_tenant_rls('app.product_locations');

create trigger touch_row before update on app.materials
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.materials
  for each row execute function app.audit_row();

create trigger touch_row before update on app.material_units
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.material_units
  for each row execute function app.audit_row();

create trigger touch_row before update on app.products_services
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.products_services
  for each row execute function app.audit_row();

create trigger touch_row before update on app.product_locations
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.product_locations
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (D-124)
----------------------------------------------------------------------------------------------------

-- Products & Services and Materials declare their permission keys now (they stay unreleased until M2
-- Step 7). Smart Setup copies the role templates of @bizcost/modules (role-templates.ts) into every new
-- business; the roles businesses already have get the same new keys here, once. A role keeps its
-- template_key when the owner edits it, and the keys are new, so no role can have refused them before.
-- The pairs below must equal the templates' new keys (docs/PRODUCT.md §8). The migration has no user:
-- the rows name the role's creator as created_by, and their audit rows have no actor or request id.
-- Every member holding a changed role gets a new permissions_version, so open apps reload their access.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'products.items.view'),
    ('admin', 'products.items.manage'),
    ('admin', 'materials.items.view'),
    ('admin', 'materials.items.manage'),
    ('manager', 'products.items.view'),
    ('manager', 'products.items.manage'),
    ('manager', 'materials.items.view'),
    ('manager', 'materials.items.manage'),
    ('accountant', 'products.items.view'),
    ('accountant', 'materials.items.view'),
    ('sales', 'products.items.view'),
    ('supervisor', 'products.items.view'),
    ('supervisor', 'materials.items.view'),
    ('employee', 'products.items.view')
),
added as (
  insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
  select app.uuid_v7(), r.business_id, r.id, d.permission_key, r.created_by
  from app.roles r
  join defaults d on d.template_key = r.template_key
  where r.deleted_at is null
  on conflict (business_id, role_id, permission_key) do nothing
  returning business_id, role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select a.business_id, a.role_id from added a);
