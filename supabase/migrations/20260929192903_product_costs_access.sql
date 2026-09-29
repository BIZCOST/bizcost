-- BizCost: product costs (M2 Step 6). The permission keys of the Cost Engine module for the roles that
-- businesses already have (as recipes_security, expenses_security and owners_answers_access did).
--
-- cost_engine.product_costs.view ("see product costs": the Product costs page and each product's
-- breakdown) needs products.recipes.view (the breakdown shows what goes into each product);
-- cost_engine.settings.manage ("change how product costs are worked out": the owner's estimate of
-- monthly purchases and hourly rate) needs cost_engine.product_costs.view (PERMISSION_NEEDS in
-- @bizcost/modules). Templates (role-templates.ts): Admin and Manager both, Accountant "see". Smart
-- Setup copies the templates into every new business; the Admin, Manager and Accountant roles
-- businesses already have get the same keys here, once. A key is added only where every key it needs
-- is live on the role (a key the owner had taken off stays off: `on conflict do nothing` keeps a
-- soft-deleted row, and whatever needs it is left out too), so no role breaks PERMISSION_NEEDS. Every
-- member holding a changed role gets a new permissions_version, so open apps reload their access. No
-- sensitive key is added: who sees the amounts is still data.cost.view (with data.supplier_price.view,
-- D-144) and data.profit_margin.view.

-- "See product costs": Admin, Manager and Accountant, where the role sees what goes into products.
with added as (
  insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
  select app.uuid_v7(), r.business_id, r.id, 'cost_engine.product_costs.view', r.created_by
  from app.roles r
  where r.template_key in ('admin', 'manager', 'accountant')
    and r.deleted_at is null
    and exists (
      select 1
      from app.role_permissions held
      where held.business_id = r.business_id
        and held.role_id = r.id
        and held.deleted_at is null
        and held.permission_key = 'products.recipes.view'
    )
  on conflict (business_id, role_id, permission_key) do nothing
  returning business_id, role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select distinct a.business_id, a.role_id from added a);

-- "Change how product costs are worked out": Admin and Manager, where the role now sees them.
with added as (
  insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
  select app.uuid_v7(), r.business_id, r.id, 'cost_engine.settings.manage', r.created_by
  from app.roles r
  where r.template_key in ('admin', 'manager')
    and r.deleted_at is null
    and exists (
      select 1
      from app.role_permissions held
      where held.business_id = r.business_id
        and held.role_id = r.id
        and held.deleted_at is null
        and held.permission_key = 'cost_engine.product_costs.view'
    )
  on conflict (business_id, role_id, permission_key) do nothing
  returning business_id, role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select distinct a.business_id, a.role_id from added a);
