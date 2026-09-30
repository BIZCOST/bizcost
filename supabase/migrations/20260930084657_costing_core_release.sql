-- BizCost: the Costing Core's release (M2 Step 7).
--
-- 1. The categories whose bills come the month after (the owner's request of 2026-09-30).
--    Smart Setup marks the starter categories electricity, water, internet and phone of every new
--    business (BILLED_NEXT_MONTH_CATEGORIES in @bizcost/domain); the businesses that exist get the
--    same here, on the categories that still carry a starter name in either language (the names of
--    the expenses_security migration, compared the way people read them: app.name_key). A renamed
--    category is left as it is; anyone may mark or unmark one (costCategory.update). Audited.
--
-- 2. Costs, supplier prices and margins are granted only together (D-144, D-187): their data keys
--    now need each other in PERMISSION_NEEDS (@bizcost/modules), so the Roles editor offers them as
--    one switch and role.updatePermissions refuses a role with some of them only. No starter template
--    breaks the rule; a role saved before it could (through role.updatePermissions). Such a role holds
--    keys that already showed nothing (visibleCategories hides the three unless all are granted), so
--    they are taken off (soft-deleted, as role.updatePermissions does) and its members get a new
--    permissions_version so open apps reload their access. Nothing anyone could see changes.

with starters (name) as (
  values
    ('Electricity'), ('الكهرباء'),
    ('Water'), ('الماء'),
    ('Internet'), ('الإنترنت'),
    ('Phone'), ('الهاتف')
)
update app.cost_categories c
set billed_next_month = true
where c.deleted_at is null
  and not c.billed_next_month
  and app.name_key(c.name) in (select app.name_key(s.name) from starters s);

with partial as (
  select rp.business_id, rp.role_id
  from app.role_permissions rp
  join app.roles r
    on r.business_id = rp.business_id and r.id = rp.role_id and r.deleted_at is null
  where rp.deleted_at is null
    and rp.permission_key in ('data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view')
  group by rp.business_id, rp.role_id
  having count(distinct rp.permission_key) < 3
),
removed as (
  update app.role_permissions rp
  set deleted_at = now()
  from partial p
  where rp.business_id = p.business_id
    and rp.role_id = p.role_id
    and rp.permission_key in ('data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view')
    and rp.deleted_at is null
  returning rp.business_id, rp.role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select r.business_id, r.role_id from removed r);
