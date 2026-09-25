-- BizCost: a user creates at most 10 businesses in 24 hours (Smart Setup, M1 Step 5).
-- app.create_business() is the only way to create a business, so the limit lives here and no API path
-- can skip it. Like the invitation limits it is counted in the database (docs/DATA_MODEL.md §4):
-- every business the user created in the last 24 hours, soft-deleted ones included, so creating and
-- deleting cannot get around it. A transaction-level advisory lock per user makes two concurrent
-- creations count each other (transaction locks work through the transaction pooler; session locks
-- do not). Over the limit: SQLSTATE BZ429, which the API answers with `rate_limited`.
-- CREATE OR REPLACE keeps the owner (postgres) and the grants of the tenancy_security migration.

create or replace function app.create_business(
  p_id uuid,
  p_legal_name text,
  p_default_locale text,
  p_owner_display_name text,
  p_owner_role_id uuid,
  p_member_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := app.current_user_id();
begin
  if v_user_id is null then
    raise exception 'create_business requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.create_business:' || v_user_id::text, 0)
  );
  if (
    select pg_catalog.count(*)
    from app.businesses b
    where b.created_by = v_user_id
      and b.created_at > pg_catalog.now() - interval '24 hours'
  ) >= 10 then
    raise exception 'business_create_limit: at most 10 businesses per user in 24 hours'
      using errcode = 'BZ429';
  end if;

  insert into app.businesses (id, legal_name, default_locale, created_by)
  values (p_id, p_legal_name, p_default_locale, v_user_id);

  insert into app.roles (id, business_id, name, template_key, created_by)
  values (p_owner_role_id, p_id, 'Owner', 'owner', v_user_id);

  insert into app.business_members (
    id, business_id, user_id, kind, display_name, status, role_id, created_by
  )
  values (
    p_member_id, p_id, v_user_id, 'account', p_owner_display_name, 'active', p_owner_role_id, v_user_id
  );

  return p_id;
end
$$;

comment on function app.create_business(uuid, text, text, text, uuid, uuid) is
  'Creates a business, its Owner role and the caller''s active Owner membership (at most 10 per user in 24 hours: SQLSTATE BZ429). Returns the business id.';
