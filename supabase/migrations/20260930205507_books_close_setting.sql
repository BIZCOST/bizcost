-- BizCost: closing the books is a Settings permission (M2 Step 7, D-201).
--
-- "Books closed up to" (D-114 rule 6) was set with purchases.books.close, a Purchases key since M2
-- Step 3 (D-137), although expenses obey the same date (D-176: it worked with Purchases or Expenses
-- on, and the Roles editor showed it only under Purchases). It is now settings.books.close, in the
-- Settings module (@bizcost/modules), shown in the Roles editor while Purchases or Expenses is on.
-- The key is renamed where it is stored: the roles that hold it (the Admin template and any role an
-- owner gave it), the members' own changes, and pending invitations. Nobody gains or loses anything.
-- Nothing is deployed yet (the hosted deploy is deferred), so the rename is done in place, in one
-- migration, rather than expand → contract: a role holding a key outside the catalog could not be
-- edited by an Admin (canGrant). The roles and members concerned get a new version so open editors
-- and apps reload.

with renamed as (
  update app.role_permissions rp
  set permission_key = 'settings.books.close'
  where rp.permission_key = 'purchases.books.close'
  returning rp.business_id, rp.role_id, rp.deleted_at
),
touched_roles as (
  update app.roles r
  set name = r.name
  where (r.business_id, r.id) in (
    select n.business_id, n.role_id from renamed n where n.deleted_at is null
  )
  returning r.business_id, r.id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select t.business_id, t.id from touched_roles t);--> statement-breakpoint

with renamed as (
  update app.member_permission_overrides o
  set permission_key = 'settings.books.close'
  where o.permission_key = 'purchases.books.close'
  returning o.business_id, o.member_id, o.deleted_at
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.id) in (
    select n.business_id, n.member_id from renamed n where n.deleted_at is null
  );--> statement-breakpoint

update app.business_invitations i
set overrides = (i.overrides - 'purchases.books.close')
  || jsonb_build_object('settings.books.close', i.overrides -> 'purchases.books.close')
where i.overrides ? 'purchases.books.close';
