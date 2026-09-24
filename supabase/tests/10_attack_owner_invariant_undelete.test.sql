-- pgTAP (attack, regression): the "at least one active Owner" rule (D6) must hold when a
-- soft-deleted business is restored. Soft-deleted businesses are exempt from the rule; without a
-- check when app.businesses.deleted_at goes back to NULL, an active non-owner member could:
--   1. soft-delete the business,
--   2. suspend the only owner (exempt: the business is deleted),
--   3. un-delete the business,
-- leaving a live business with zero active owners.
-- Fixed: a constraint trigger on businesses re-checks the rule on restore.
begin;
select plan(5);

-- Check deferred constraint triggers at each statement (a rolled-back test never reaches COMMIT).
set constraints all immediate;

do $$
begin
  if not pg_has_role(current_user, 'bizcost_api', 'SET') then
    execute format('grant bizcost_api to %I', current_user);
  end if;
exception when others then
  raise warning 'cannot let % SET ROLE bizcost_api: %', current_user, sqlerrm;
end
$$;

create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5('attack undelete ' || p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

-- Runs p_sql as bizcost_api with the given user/business, like withTenantTx.
-- Returns 'ok <row count>' or 'ERROR <sqlstate>: <message>'.
create function pg_temp.api_exec(p_user text, p_business text, p_sql text)
returns text
language plpgsql
as $$
declare
  v_out text;
  v_rows bigint;
begin
  perform set_config('app.user_id', coalesce(pg_temp.id(p_user)::text, ''), true);
  perform set_config('app.business_id', coalesce(pg_temp.id(p_business)::text, ''), true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'ok ' || v_rows;
  exception when others then
    v_out := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  perform set_config('app.user_id', '', true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.request_id', '', true);
  return v_out;
end
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values ('owner', 'owner.undelete@example.test'),
               ('staff', 'staff.undelete@example.test')) as u(name, email);

-- Setup: owner creates the business and adds an active, non-owner staff member.
select is(
  pg_temp.api_exec('owner', null, $$
    select app.create_business(pg_temp.id('biz'), 'Undelete Trading', 'en', 'Owner',
                               pg_temp.id('owner role'), pg_temp.id('owner member')) $$),
  'ok 1',
  'setup: owner creates the business'
);

select is(
  pg_temp.api_exec('owner', 'biz', $$
    with r as (
      insert into app.roles (id, business_id, name, template_key)
      values (pg_temp.id('staff role'), pg_temp.id('biz'), 'Staff', null)
      returning id
    )
    insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
    select pg_temp.id('staff member'), pg_temp.id('biz'), pg_temp.id('staff'), 'account', 'Staff', 'active', r.id
      from r $$),
  'ok 1',
  'setup: owner adds an active staff member (not an owner)'
);

-- Attack, as the staff member (each step is its own API transaction in real life).
select is(
  pg_temp.api_exec('staff', 'biz', $$
    update app.businesses set deleted_at = now() where id = pg_temp.id('biz') $$),
  'ok 1',
  'step 1: staff soft-deletes the business'
);

select is(
  pg_temp.api_exec('staff', 'biz', $$
    update app.business_members set status = 'suspended' where id = pg_temp.id('owner member') $$),
  'ok 1',
  'step 2: staff suspends the only owner (allowed: the business is soft-deleted)'
);

-- Step 3: un-deleting the business must be rejected (or at the latest fail at commit), because the
-- business would be live again with no active owner.
select matches(
  pg_temp.api_exec('staff', 'biz', $$
    update app.businesses set deleted_at = null where id = pg_temp.id('biz') $$),
  '^ERROR',
  'step 3: un-deleting a business that has no active owner is rejected'
);

select * from finish();
rollback;
