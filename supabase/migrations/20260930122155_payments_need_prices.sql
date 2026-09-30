-- BizCost: approving expenses and recording payments go with the costs switch (D-200).
--
-- Each use of expenses.documents.approve, expenses.payments.record and purchases.payments.record shows
-- or settles what was paid, so the API refuses it to a member who may not see supplier prices
-- (FORBIDDEN, D-160, D-175). They now need data.supplier_price.view in PERMISSION_NEEDS
-- (@bizcost/modules): the Roles editor and a member's own permissions switch them off with "See costs,
-- supplier prices and margins", role.updatePermissions refuses them without it, and a member's
-- effective access drops them without it (withNeededKeys). No starter template breaks the rule; a role
-- saved before it could. Its keys already granted nothing, so they are taken off (soft-deleted, as
-- role.updatePermissions does) and its members get a new permissions_version so open apps reload their
-- access. A member's own "allow" of one of them without supplier prices already grants nothing
-- (withNeededKeys) and goes at their next save. Nothing anyone could do changes.

with holders as (
  select rp.business_id, rp.role_id
  from app.role_permissions rp
  join app.roles r
    on r.business_id = rp.business_id and r.id = rp.role_id and r.deleted_at is null
  where rp.deleted_at is null
    and rp.permission_key in (
      'expenses.documents.approve', 'expenses.payments.record', 'purchases.payments.record'
    )
    and not exists (
      select 1 from app.role_permissions p
      where p.business_id = rp.business_id
        and p.role_id = rp.role_id
        and p.permission_key = 'data.supplier_price.view'
        and p.deleted_at is null
    )
  group by rp.business_id, rp.role_id
),
removed as (
  update app.role_permissions rp
  set deleted_at = now()
  from holders h
  where rp.business_id = h.business_id
    and rp.role_id = h.role_id
    and rp.permission_key in (
      'expenses.documents.approve', 'expenses.payments.record', 'purchases.payments.record'
    )
    and rp.deleted_at is null
  returning rp.business_id, rp.role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select r.business_id, r.role_id from removed r);
