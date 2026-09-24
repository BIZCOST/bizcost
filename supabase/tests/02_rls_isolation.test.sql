-- pgTAP: tenant isolation between two businesses, exercised as role bizcost_api.
-- Scenario: user A owns business A, user B owns business B, user C is an active
-- member of both. Every M1 tenant table gets rows in both businesses; then we check
-- reads, cross-tenant writes, missing and wrong context, suspended/removed members,
-- composite FKs and the identity-table policies (profiles, businesses, members).
begin;
select plan(162);

-- ---------------------------------------------------------------------------------
-- Helpers (session-local; everything is rolled back at the end).
-- pgTAP always runs as the test owner. Statements under test run as bizcost_api via
-- pg_temp.api_exec / pg_temp.api_value: they set the tenant context like withTenantTx
-- (transaction-local set_config), switch role, run the statement, capture its result
-- or error, then switch back and clear the context.
-- ---------------------------------------------------------------------------------

-- On Supabase, postgres is not a superuser: make sure it may SET ROLE bizcost_api.
do $$
begin
  if not pg_has_role(current_user, 'bizcost_api', 'SET') then
    execute format('grant bizcost_api to %I', current_user);
  end if;
exception when others then
  raise warning 'cannot let % SET ROLE bizcost_api: %', current_user, sqlerrm;
end
$$;

-- Readable, deterministic fixture ids: pg_temp.id('biz A') is always the same uuid.
create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5(p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

-- Runs p_sql as bizcost_api with the given user/business (fixture names; null = unset).
-- Returns 'ok <row count>', the first column of the first row as text (p_scalar),
-- or 'ERROR <sqlstate>: <message>'.
create function pg_temp.api_run(p_user text, p_business text, p_sql text, p_scalar boolean, p_request text)
returns text
language plpgsql
as $$
declare
  v_out text;
  v_rows bigint;
begin
  perform set_config('app.user_id', coalesce(pg_temp.id(p_user)::text, ''), true);
  perform set_config('app.business_id', coalesce(pg_temp.id(p_business)::text, ''), true);
  perform set_config('app.request_id', coalesce(pg_temp.id(p_request)::text, ''), true);
  begin
    set local role bizcost_api;
    if p_scalar then
      execute p_sql into v_out;
    else
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_out := 'ok ' || v_rows;
    end if;
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

create function pg_temp.api_exec(p_user text, p_business text, p_sql text, p_request text default 'request')
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, false, p_request) $$;

create function pg_temp.api_value(p_user text, p_business text, p_sql text, p_request text default 'request')
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, true, p_request) $$;

-- '<rows of p_home>/<rows of any other business>' that p_user sees in app.<p_table>
-- with p_business as context.
create function pg_temp.rows_seen(p_user text, p_business text, p_table text, p_home text)
returns text language sql
as $$
  select pg_temp.api_value(p_user, p_business, format(
    'select count(*) filter (where business_id = %L) || ''/'' || count(*) filter (where business_id <> %L) from app.%I',
    pg_temp.id(p_home), pg_temp.id(p_home), p_table))
$$;

-- ---------------------------------------------------------------------------------
-- Fixtures: three confirmed auth users (auth is not reachable by bizcost_api).
-- ---------------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values ('user A', 'alice@example.test'),
               ('user B', 'badr@example.test'),
               ('user C', 'chris@example.test')) as u(name, email);

-- 1. Bootstrap: two businesses through app.create_business (2) ------------------------

select is(
  pg_temp.api_value('user A', null, $$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Trading', 'en', 'Alice',
                               pg_temp.id('owner role A'), pg_temp.id('owner member A')) $$),
  pg_temp.id('biz A')::text,
  'user A creates business A through app.create_business'
);

select is(
  pg_temp.api_value('user B', null, $$
    select app.create_business(pg_temp.id('biz B'), 'Beta Bakery', 'ar', 'Badr',
                               pg_temp.id('owner role B'), pg_temp.id('owner member B')) $$),
  pg_temp.id('biz B')::text,
  'user B creates business B through app.create_business'
);

-- 2. Seed one row per tenant table and business, as each owner (24) ------------------

select is(pg_temp.api_exec(v.who, v.biz, v.stmt), 'ok 1', v.what)
  from (values
    ('user A', null, 'user A creates own profile',
     $$insert into app.profiles (id, display_name, locale) values (pg_temp.id('user A'), 'Alice', 'en')$$),
    ('user B', null, 'user B creates own profile',
     $$insert into app.profiles (id, display_name, locale) values (pg_temp.id('user B'), 'Badr', 'ar')$$),
    ('user C', null, 'user C creates own profile',
     $$insert into app.profiles (id, display_name, locale) values (pg_temp.id('user C'), 'Chris', 'en')$$),

    ('user A', 'biz A', 'A: add a location',
     $$insert into app.locations (id, business_id, name, is_default)
       values (pg_temp.id('location A'), pg_temp.id('biz A'), 'Main branch', true)$$),
    ('user A', 'biz A', 'A: add a custom role',
     $$insert into app.roles (id, business_id, name, template_key)
       values (pg_temp.id('staff role A'), pg_temp.id('biz A'), 'Cashier', null)$$),
    ('user A', 'biz A', 'A: grant the role a permission',
     $$insert into app.role_permissions (id, business_id, role_id, permission_key)
       values (pg_temp.id('role permission A'), pg_temp.id('biz A'), pg_temp.id('staff role A'), 'settings.business.view')$$),
    ('user A', 'biz A', 'A: add user C as an active member',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member C in A'), pg_temp.id('biz A'), pg_temp.id('user C'), 'account', 'Chris', 'active',
               pg_temp.id('staff role A'))$$),
    ('user A', 'biz A', 'A: add a permission override',
     $$insert into app.member_permission_overrides (id, business_id, member_id, permission_key, effect)
       values (pg_temp.id('override A'), pg_temp.id('biz A'), pg_temp.id('member C in A'), 'settings.members.view', 'allow')$$),
    ('user A', 'biz A', 'A: scope the member to a location',
     $$insert into app.member_locations (id, business_id, member_id, location_id)
       values (pg_temp.id('member location A'), pg_temp.id('biz A'), pg_temp.id('member C in A'), pg_temp.id('location A'))$$),
    ('user A', 'biz A', 'A: set a capability',
     $$insert into app.business_capabilities (id, business_id, key, enabled, source)
       values (pg_temp.id('capability A'), pg_temp.id('biz A'), 'multi_location', true, 'setup')$$),
    ('user A', 'biz A', 'A: enable a module',
     $$insert into app.business_modules (id, business_id, module_key, enabled, enabled_at, enabled_by)
       values (pg_temp.id('module A'), pg_temp.id('biz A'), 'dashboard', true, now(), pg_temp.id('user A'))$$),
    ('user A', 'biz A', 'A: invite someone',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('invitation A'), pg_temp.id('biz A'), 'new.hire.a@example.test',
               encode(sha256(convert_to('token A', 'UTF8')), 'hex'), now() + interval '7 days', 'pending',
               pg_temp.id('staff role A'), '{}', array[]::uuid[], 1, now())$$),
    ('user A', 'biz A', 'A: save setup answers',
     $$insert into app.setup_answers (id, business_id, question_set_version, answers)
       values (pg_temp.id('setup answers A'), pg_temp.id('biz A'), 1, '{"business_type": "trading"}')$$),

    ('user B', 'biz B', 'B: add a location',
     $$insert into app.locations (id, business_id, name, is_default)
       values (pg_temp.id('location B'), pg_temp.id('biz B'), 'Bakery', true)$$),
    ('user B', 'biz B', 'B: add a custom role',
     $$insert into app.roles (id, business_id, name, template_key)
       values (pg_temp.id('staff role B'), pg_temp.id('biz B'), 'Baker', null)$$),
    ('user B', 'biz B', 'B: grant the role a permission',
     $$insert into app.role_permissions (id, business_id, role_id, permission_key)
       values (pg_temp.id('role permission B'), pg_temp.id('biz B'), pg_temp.id('staff role B'), 'settings.business.view')$$),
    ('user B', 'biz B', 'B: add user C as an active member',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member C in B'), pg_temp.id('biz B'), pg_temp.id('user C'), 'account', 'Chris', 'active',
               pg_temp.id('staff role B'))$$),
    ('user B', 'biz B', 'B: add a pin-only member (no login)',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('pin member B'), pg_temp.id('biz B'), null, 'pin_only', 'Counter staff', 'active',
               pg_temp.id('staff role B'))$$),
    ('user B', 'biz B', 'B: add a permission override',
     $$insert into app.member_permission_overrides (id, business_id, member_id, permission_key, effect)
       values (pg_temp.id('override B'), pg_temp.id('biz B'), pg_temp.id('member C in B'), 'settings.members.view', 'deny')$$),
    ('user B', 'biz B', 'B: scope the member to a location',
     $$insert into app.member_locations (id, business_id, member_id, location_id)
       values (pg_temp.id('member location B'), pg_temp.id('biz B'), pg_temp.id('member C in B'), pg_temp.id('location B'))$$),
    ('user B', 'biz B', 'B: set a capability',
     $$insert into app.business_capabilities (id, business_id, key, enabled, source)
       values (pg_temp.id('capability B'), pg_temp.id('biz B'), 'multi_location', false, 'user')$$),
    ('user B', 'biz B', 'B: enable a module',
     $$insert into app.business_modules (id, business_id, module_key, enabled, enabled_at, enabled_by)
       values (pg_temp.id('module B'), pg_temp.id('biz B'), 'dashboard', true, now(), pg_temp.id('user B'))$$),
    ('user B', 'biz B', 'B: invite someone',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('invitation B'), pg_temp.id('biz B'), 'new.hire.b@example.test',
               encode(sha256(convert_to('token B', 'UTF8')), 'hex'), now() + interval '7 days', 'pending',
               pg_temp.id('staff role B'), '{}', array[]::uuid[], 1, now())$$),
    ('user B', 'biz B', 'B: save setup answers',
     $$insert into app.setup_answers (id, business_id, question_set_version, answers)
       values (pg_temp.id('setup answers B'), pg_temp.id('biz B'), 1, '{"business_type": "bakery"}')$$)
  ) as v(who, biz, what, stmt);

-- 3. Each owner sees only its own business's rows (22) -------------------------------------

select is(pg_temp.rows_seen('user A', 'biz A', v.tbl, 'biz A'), v.expected,
          format('user A in business A sees only business A rows in app.%s', v.tbl))
  from (values ('locations', '1/0'), ('roles', '2/0'), ('role_permissions', '1/0'),
               ('business_members', '2/0'), ('member_permission_overrides', '1/0'),
               ('member_locations', '1/0'), ('business_capabilities', '1/0'),
               ('business_modules', '1/0'), ('business_invitations', '1/0'),
               ('setup_answers', '1/0')) as v(tbl, expected);

select matches(pg_temp.rows_seen('user A', 'biz A', 'audit_log', 'biz A'), '^[1-9][0-9]*/0$',
               'user A in business A sees only business A rows in app.audit_log');

select is(pg_temp.rows_seen('user B', 'biz B', v.tbl, 'biz B'), v.expected,
          format('user B in business B sees only business B rows in app.%s', v.tbl))
  from (values ('locations', '1/0'), ('roles', '2/0'), ('role_permissions', '1/0'),
               ('business_members', '3/0'), ('member_permission_overrides', '1/0'),
               ('member_locations', '1/0'), ('business_capabilities', '1/0'),
               ('business_modules', '1/0'), ('business_invitations', '1/0'),
               ('setup_answers', '1/0')) as v(tbl, expected);

select matches(pg_temp.rows_seen('user B', 'biz B', 'audit_log', 'biz B'), '^[1-9][0-9]*/0$',
               'user B in business B sees only business B rows in app.audit_log');

-- 4. Cross-tenant writes from business A against business B (32) ----------------------------

select is(
  pg_temp.api_exec('user A', 'biz A',
    format('update app.%I set deleted_at = now() where business_id = %L', v.tbl, pg_temp.id('biz B'))),
  'ok 0',
  format('user A cannot update business B rows in app.%s', v.tbl))
  from unnest(array['locations', 'roles', 'role_permissions', 'business_members',
                    'member_permission_overrides', 'member_locations', 'business_capabilities',
                    'business_modules', 'business_invitations', 'setup_answers']) as v(tbl);

select is(
  pg_temp.api_exec('user A', 'biz A',
    format('delete from app.%I where business_id = %L', v.tbl, pg_temp.id('biz B'))),
  'ok 0',
  format('user A cannot delete business B rows in app.%s', v.tbl))
  from unnest(array['locations', 'roles', 'role_permissions', 'business_members',
                    'member_permission_overrides', 'member_locations', 'business_capabilities',
                    'business_modules', 'business_invitations', 'setup_answers']) as v(tbl);

select matches(pg_temp.api_exec('user A', 'biz A', v.stmt), '^ERROR 42501', v.what)
  from (values
    ('user A cannot insert a location into business B',
     $$insert into app.locations (id, business_id, name, is_default)
       values (pg_temp.id('evil location'), pg_temp.id('biz B'), 'Evil', false)$$),
    ('user A cannot insert a role into business B',
     $$insert into app.roles (id, business_id, name, template_key)
       values (pg_temp.id('evil role'), pg_temp.id('biz B'), 'Evil', 'owner')$$),
    ('user A cannot grant permissions to a business B role',
     $$insert into app.role_permissions (id, business_id, role_id, permission_key)
       values (pg_temp.id('evil permission'), pg_temp.id('biz B'), pg_temp.id('staff role B'), 'settings.members.manage')$$),
    ('user A cannot make itself an owner of business B',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('evil member'), pg_temp.id('biz B'), pg_temp.id('user A'), 'account', 'Alice', 'active',
               pg_temp.id('owner role B'))$$),
    ('user A cannot add a permission override in business B',
     $$insert into app.member_permission_overrides (id, business_id, member_id, permission_key, effect)
       values (pg_temp.id('evil override'), pg_temp.id('biz B'), pg_temp.id('member C in B'), 'settings.members.manage', 'allow')$$),
    ('user A cannot change a location scope in business B',
     $$insert into app.member_locations (id, business_id, member_id, location_id)
       values (pg_temp.id('evil member location'), pg_temp.id('biz B'), pg_temp.id('member C in B'), pg_temp.id('location B'))$$),
    ('user A cannot set a capability of business B',
     $$insert into app.business_capabilities (id, business_id, key, enabled, source)
       values (pg_temp.id('evil capability'), pg_temp.id('biz B'), 'keeps_stock', true, 'user')$$),
    ('user A cannot enable a module of business B',
     $$insert into app.business_modules (id, business_id, module_key, enabled, enabled_at, enabled_by)
       values (pg_temp.id('evil module'), pg_temp.id('biz B'), 'settings', true, now(), pg_temp.id('user A'))$$),
    ('user A cannot invite people into business B',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('evil invitation'), pg_temp.id('biz B'), 'alice@example.test',
               encode(sha256(convert_to('token evil', 'UTF8')), 'hex'), now() + interval '7 days', 'pending',
               pg_temp.id('owner role B'), '{}', array[]::uuid[], 1, now())$$),
    ('user A cannot write setup answers for business B',
     $$insert into app.setup_answers (id, business_id, question_set_version, answers)
       values (pg_temp.id('evil answers'), pg_temp.id('biz B'), 1, '{}')$$),
    ('user A cannot forge audit rows for business B',
     $$insert into app.audit_log (id, business_id, actor_user_id, action, entity, entity_id, request_id, changes, created_at)
       values (pg_temp.id('evil audit'), pg_temp.id('biz B'), pg_temp.id('user A'), 'insert', 'locations',
               pg_temp.id('location B'), null, '{}', now())$$)
  ) as v(what, stmt);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.locations set business_id = pg_temp.id('biz B') where id = pg_temp.id('location A') $$),
  '^ERROR',
  'user A cannot move a business A row into business B'
);

-- 5. Missing tenant context fails closed (27) -------------------------------------------------

select is(pg_temp.api_value(null, null, format('select count(*) from app.%I', v.tbl)), '0',
          format('without any context app.%s returns no rows', v.tbl))
  from unnest(array['locations', 'roles', 'role_permissions', 'business_members',
                    'member_permission_overrides', 'member_locations', 'business_capabilities',
                    'business_modules', 'business_invitations', 'setup_answers', 'audit_log',
                    'businesses', 'profiles']) as v(tbl);

select is(pg_temp.api_value(null, 'biz A', format('select count(*) from app.%I', v.tbl)), '0',
          format('with a business but no user, app.%s returns no rows', v.tbl))
  from unnest(array['locations', 'roles', 'role_permissions', 'business_members',
                    'member_permission_overrides', 'member_locations', 'business_capabilities',
                    'business_modules', 'business_invitations', 'setup_answers', 'audit_log',
                    'businesses', 'profiles']) as v(tbl);

select matches(
  pg_temp.api_exec(null, null, $$
    insert into app.locations (id, business_id, name, is_default)
    values (pg_temp.id('ghost location'), pg_temp.id('biz A'), 'Ghost', false) $$),
  '^ERROR',
  'without context nothing can be inserted'
);

-- 6. A valid user naming a business it does not belong to (14) -----------------------------------

select is(pg_temp.api_value('user A', 'biz B', format('select count(*) from app.%I', v.tbl)), '0',
          format('user A with business B as context sees no rows in app.%s', v.tbl))
  from unnest(array['locations', 'roles', 'role_permissions', 'member_permission_overrides',
                    'member_locations', 'business_capabilities', 'business_modules',
                    'business_invitations', 'setup_answers', 'audit_log']) as v(tbl);

select is(
  pg_temp.rows_seen('user A', 'biz B', 'business_members', 'biz A'),
  '1/0',
  'with business B as context, user A sees only its own membership row'
);

select is(
  pg_temp.api_value('user A', 'biz B', $$select string_agg(id::text, ',') from app.businesses$$),
  pg_temp.id('biz A')::text,
  'naming business B in context does not add it to user A''s business list'
);

select matches(
  pg_temp.api_exec('user A', 'biz B', $$
    insert into app.locations (id, business_id, name, is_default)
    values (pg_temp.id('forged location'), pg_temp.id('biz B'), 'Forged', false) $$),
  '^ERROR 42501',
  'a non-member cannot insert into business B by naming it in context'
);

select is(
  pg_temp.api_exec('user A', 'biz B', $$
    update app.locations set name = 'Forged' where business_id = pg_temp.id('biz B') $$),
  'ok 0',
  'a non-member cannot update business B by naming it in context'
);

-- 7. Composite FKs make cross-business links impossible, even for a legitimate owner (5) --

select matches(pg_temp.api_exec('user A', 'biz A', v.stmt), '^ERROR 23503', v.what)
  from (values
    ('a business A member cannot get a business B role',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('cross member'), pg_temp.id('biz A'), pg_temp.id('user B'), 'account', 'Badr', 'active',
               pg_temp.id('staff role B'))$$),
    ('a business A permission row cannot point at a business B role',
     $$insert into app.role_permissions (id, business_id, role_id, permission_key)
       values (pg_temp.id('cross permission'), pg_temp.id('biz A'), pg_temp.id('staff role B'), 'settings.business.edit')$$),
    ('a business A member cannot be scoped to a business B location',
     $$insert into app.member_locations (id, business_id, member_id, location_id)
       values (pg_temp.id('cross member location'), pg_temp.id('biz A'), pg_temp.id('member C in A'), pg_temp.id('location B'))$$),
    ('a business A override cannot point at a business B member',
     $$insert into app.member_permission_overrides (id, business_id, member_id, permission_key, effect)
       values (pg_temp.id('cross override'), pg_temp.id('biz A'), pg_temp.id('member C in B'), 'settings.business.edit', 'allow')$$),
    ('a business A invitation cannot grant a business B role',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('cross invitation'), pg_temp.id('biz A'), 'cross@example.test',
               encode(sha256(convert_to('token cross', 'UTF8')), 'hex'), now() + interval '7 days', 'pending',
               pg_temp.id('staff role B'), '{}', array[]::uuid[], 1, now())$$)
  ) as v(what, stmt);

-- 8. profiles: own row only (5) -------------------------------------------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', $$select string_agg(id::text, ',') from app.profiles$$),
  pg_temp.id('user A')::text,
  'user A sees only its own profile'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.profiles (id, display_name, locale) values (pg_temp.id('user D'), 'Dana', 'en') $$),
  '^ERROR 42501',
  'user A cannot create a profile for someone else'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.profiles set display_name = 'Hacked' where id = pg_temp.id('user B') $$),
  'ok 0',
  'user A cannot update another user''s profile'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$delete from app.profiles where id = pg_temp.id('user A')$$),
  '^(ok 0|ERROR 42501)',
  'profiles cannot be deleted (they are anonymized instead)'
);

select is(
  pg_temp.api_exec('user A', null, $$
    update app.profiles set display_name = 'Alice Q.' where id = pg_temp.id('user A') $$),
  'ok 1',
  'user A can update its own profile'
);

-- 9. businesses: listed where the caller is an active member (8) -------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', $$select string_agg(id::text, ',') from app.businesses$$),
  pg_temp.id('biz A')::text,
  'user A lists only business A'
);

select is(
  pg_temp.api_value('user B', 'biz B', $$select string_agg(id::text, ',') from app.businesses$$),
  pg_temp.id('biz B')::text,
  'user B lists only business B'
);

select is(
  pg_temp.api_value('user C', 'biz A', $$select count(*) from app.businesses$$),
  '2',
  'user C, active in both, lists both businesses (business switcher)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.businesses set legal_name = 'Hacked' where id = pg_temp.id('biz B') $$),
  'ok 0',
  'user A cannot update business B'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.businesses set legal_name_ar = 'Alpha AR' where id = pg_temp.id('biz A') $$),
  'ok 1',
  'user A can update its current business'
);

select is(
  pg_temp.api_exec('user A', 'biz B', $$
    update app.businesses set legal_name_ar = 'Alpha AR 2' where id = pg_temp.id('biz A') $$),
  'ok 0',
  'user A cannot update business A while another business is the current one'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.businesses (id, legal_name, default_locale) values (pg_temp.id('biz Z'), 'Zed', 'en') $$),
  '^ERROR 42501',
  'businesses cannot be inserted directly (only through app.create_business)'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$delete from app.businesses where id = pg_temp.id('biz A')$$),
  '^(ok 0|ERROR 42501)',
  'businesses cannot be deleted by the API role'
);

-- 10. business_members: own memberships are readable across businesses (2) -----------------

select is(
  pg_temp.rows_seen('user C', 'biz A', 'business_members', 'biz A'),
  '2/1',
  'user C in business A sees A''s members plus its own membership in B'
);

select is(
  pg_temp.api_exec('user C', 'biz A', $$
    update app.business_members set display_name = 'Chris X' where id = pg_temp.id('member C in B') $$),
  'ok 0',
  'the own-membership read does not allow writing the membership of another business'
);

-- 11. Suspended, removed and soft-deleted members lose access immediately (21) ---------------

select is(
  pg_temp.rows_seen('user C', 'biz A', 'locations', 'biz A'),
  '1/0',
  'active member C reads business A'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set status = 'suspended' where id = pg_temp.id('member C in A') $$),
  'ok 1',
  'owner A suspends member C'
);

select is(pg_temp.api_value('user C', 'biz A', format('select count(*) from app.%I', v.tbl)), '0',
          format('suspended member C sees no rows in app.%s', v.tbl))
  from unnest(array['locations', 'roles', 'role_permissions', 'member_permission_overrides',
                    'member_locations', 'business_capabilities', 'business_modules',
                    'business_invitations', 'setup_answers', 'audit_log']) as v(tbl);

select is(
  pg_temp.rows_seen('user C', 'biz A', 'business_members', 'biz A'),
  '1/1',
  'suspended member C still sees only its own memberships (A and B)'
);

select is(
  pg_temp.api_value('user C', 'biz A', $$select string_agg(id::text, ',') from app.businesses$$),
  pg_temp.id('biz B')::text,
  'business A disappears from suspended member C''s business list'
);

select is(
  pg_temp.rows_seen('user C', 'biz B', 'locations', 'biz B'),
  '1/0',
  'member C still reads business B, where it is active'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set status = 'removed' where id = pg_temp.id('member C in A') $$),
  'ok 1',
  'owner A removes member C'
);

select is(
  pg_temp.api_value('user C', 'biz A', $$select count(*) from app.locations$$),
  '0',
  'removed member C sees no business A rows'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set status = 'active' where id = pg_temp.id('member C in A') $$),
  'ok 1',
  'owner A re-activates member C'
);

select is(
  pg_temp.rows_seen('user C', 'biz A', 'locations', 'biz A'),
  '1/0',
  're-activated member C reads business A again'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set deleted_at = now() where id = pg_temp.id('member C in A') $$),
  'ok 1',
  'owner A soft-deletes member C''s membership'
);

select is(
  pg_temp.api_value('user C', 'biz A', $$select count(*) from app.locations$$),
  '0',
  'a soft-deleted membership gives no access even with status active'
);

select * from finish();
rollback;
