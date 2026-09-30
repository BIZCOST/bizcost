-- pgTAP: closing the books is a Settings permission (M2 Step 7, D-201). The migration
-- books_close_setting renamed the stored key purchases.books.close to settings.books.close in the roles
-- that hold it, in members' own changes and in pending invitations; the API writes only keys of the
-- catalog, which no longer has the old one. So no row, live or soft-deleted, still carries it.
begin;
select plan(3);

select is(
  (select count(*) from app.role_permissions where permission_key = 'purchases.books.close'),
  0::bigint,
  'no role holds the old key purchases.books.close (renamed settings.books.close)'
);

select is(
  (select count(*) from app.member_permission_overrides
    where permission_key = 'purchases.books.close'),
  0::bigint,
  'no member''s own change names the old key purchases.books.close'
);

select is(
  (select count(*) from app.business_invitations where overrides ? 'purchases.books.close'),
  0::bigint,
  'no invitation carries the old key purchases.books.close'
);

select * from finish();
rollback;
