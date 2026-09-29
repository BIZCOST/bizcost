-- BizCost: seeing what goes into each product needs seeing its materials (M2 Step 4, D-155).
--
-- A recipe names its materials, their packs and, with costs, their averages: the numbers
-- material.get and material.costs refuse a member without materials.items.view. From now on
-- products.recipes.view needs materials.items.view as well as products.items.view (PERMISSION_NEEDS
-- in @bizcost/modules, enforced by role.updatePermissions; the recipe procedures check it too). No
-- starter template breaks the rule; a role saved before it could. Such a role loses the recipe keys
-- (the change that grants nothing new), and its members get a new permissions_version so open apps
-- reload their access. Rows are soft-deleted, as role.updatePermissions does.

with incoherent as (
  select rp.business_id, rp.role_id
  from app.role_permissions rp
  join app.roles r
    on r.business_id = rp.business_id and r.id = rp.role_id and r.deleted_at is null
  where rp.permission_key = 'products.recipes.view'
    and rp.deleted_at is null
    and not exists (
      select 1 from app.role_permissions m
      where m.business_id = rp.business_id
        and m.role_id = rp.role_id
        and m.permission_key = 'materials.items.view'
        and m.deleted_at is null
    )
),
removed as (
  update app.role_permissions rp
  set deleted_at = now()
  from incoherent i
  where rp.business_id = i.business_id
    and rp.role_id = i.role_id
    and rp.permission_key in ('products.recipes.view', 'products.recipes.manage')
    and rp.deleted_at is null
  returning rp.business_id, rp.role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select r.business_id, r.role_id from removed r);
