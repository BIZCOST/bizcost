-- pgTAP: context/bootstrap functions, triggers and data invariants (Milestone 1, Step 1).
-- Covers app.create_business, app.accept_invitation, app.touch_row, app.audit_row,
-- the "at least one active owner" rule and the CHECK/UNIQUE constraints of D5-D11.
-- Statements under test run as bizcost_api with tenant context, like the API does.
begin;
select plan(119);

-- The owner rule is a DEFERRABLE INITIALLY DEFERRED constraint trigger that normally
-- fires at COMMIT, which a rolled-back test never reaches: check it per statement.
set constraints all immediate;

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

-- ---------------------------------------------------------------------------------
-- Fixtures: auth users (email_confirmed_at null = unverified).
-- ---------------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, u.confirmed_at, '{}', '{}', now(), now()
  from (values
    ('user A', 'alice@example.test',     now()),  -- owner of business A
    ('user B', 'badr@example.test',      now()),  -- owner of business B
    ('user C', 'chris@example.test',     now()),  -- member of business A
    ('user I', 'ivy@example.test',       now()),  -- invitee with a profile
    ('user J', 'jay.smith@example.test', now()),  -- invitee without a profile
    ('user Q', 'quinn@example.test',     now()),  -- removed member, invited back
    ('user U', 'una@example.test',       null),   -- email not verified
    ('user W', 'walt@example.test',      now()),  -- uses someone else's token
    ('user L', 'lena@example.test',      now()),  -- invitation expired
    ('user R', 'rami@example.test',      now()),  -- invitation revoked
    ('user X', 'xena@example.test',      now())   -- invitation scoped to a foreign location
  ) as u(name, email, confirmed_at);

-- 1. Context and membership functions (12) ---------------------------------------------

select volatility_is('app', 'current_user_id', '{}'::name[], 'stable', 'app.current_user_id() is STABLE');
select volatility_is('app', 'current_business_id', '{}'::name[], 'stable', 'app.current_business_id() is STABLE');
select volatility_is('app', 'is_active_member', array['uuid']::name[], 'stable', 'app.is_active_member(uuid) is STABLE');
select is_definer('app', 'is_active_member', array['uuid']::name[], 'app.is_active_member(uuid) is SECURITY DEFINER');
select volatility_is('app', 'my_business_ids', '{}'::name[], 'stable', 'app.my_business_ids() is STABLE');
select is_definer('app', 'my_business_ids', '{}'::name[], 'app.my_business_ids() is SECURITY DEFINER');
select function_returns('app', 'my_business_ids', '{}'::name[], 'setof uuid', 'app.my_business_ids() returns setof uuid');
select is_definer('app', 'create_business', array['uuid', 'text', 'text', 'text', 'uuid', 'uuid']::name[],
                  'app.create_business(...) is SECURITY DEFINER');
select is_definer('app', 'accept_invitation', array['text', 'uuid']::name[],
                  'app.accept_invitation(text, uuid) is SECURITY DEFINER');

select is(
  pg_temp.api_value('user A', 'biz A', $$select app.current_user_id()$$),
  pg_temp.id('user A')::text,
  'app.current_user_id() reads app.user_id'
);

select is(
  pg_temp.api_value('user A', 'biz A', $$select app.current_business_id()$$),
  pg_temp.id('biz A')::text,
  'app.current_business_id() reads app.business_id'
);

select is(
  pg_temp.api_value(null, null, $$
    select coalesce(app.current_user_id()::text, 'null') || ',' || coalesce(app.current_business_id()::text, 'null') $$),
  'null,null',
  'an empty context reads as NULL (fails closed)'
);

-- 2. app.create_business (12) ----------------------------------------------------------------
-- Note: format('%s', <boolean>) uses the type's output function, so booleans read 't'/'f'.

select is(
  pg_temp.api_value('user A', null, $$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Trading', 'en', 'Alice',
                               pg_temp.id('owner role A'), pg_temp.id('owner member A')) $$),
  pg_temp.id('biz A')::text,
  'create_business returns the new business id'
);

select is(
  (select format('%s|%s|%s|%s|%s', legal_name, default_locale, created_by = pg_temp.id('user A'), version,
                 deleted_at is null)
     from app.businesses where id = pg_temp.id('biz A')),
  'Alpha Trading|en|t|1|t',
  'the business stores its name and locale and records the caller as creator'
);

select results_eq(
  $$ select id, name::text, template_key::text from app.roles where business_id = pg_temp.id('biz A') $$,
  $$ values (pg_temp.id('owner role A'), 'Owner', 'owner') $$,
  'create_business creates exactly one role: Owner (template owner)'
);

select results_eq(
  $$ select id, user_id, kind::text, status::text, role_id, display_name::text
       from app.business_members where business_id = pg_temp.id('biz A') $$,
  $$ values (pg_temp.id('owner member A'), pg_temp.id('user A'), 'account', 'active', pg_temp.id('owner role A'), 'Alice') $$,
  'create_business makes the caller an active account member with the Owner role'
);

select is_empty(
  $$ select id from app.role_permissions where business_id = pg_temp.id('biz A') $$,
  'Owner permissions are implicit: no role_permissions rows'
);

select is_empty(
  $$ select id from app.locations where business_id = pg_temp.id('biz A') $$,
  'no default location yet (Smart Setup creates it)'
);

select matches(
  pg_temp.api_value(null, null, $$
    select app.create_business(pg_temp.id('biz Z'), 'Zed', 'en', 'Nobody',
                               pg_temp.id('owner role Z'), pg_temp.id('owner member Z')) $$),
  '^ERROR',
  'create_business requires a user in context'
);

select is(
  pg_temp.api_value('user B', null, $$
    select app.create_business(pg_temp.id('biz B'), 'Beta Bakery', 'ar', 'Badr',
                               pg_temp.id('owner role B'), pg_temp.id('owner member B')) $$),
  pg_temp.id('biz B')::text,
  'user B creates business B'
);

select matches(
  pg_temp.api_value('user A', null, $$
    select app.create_business(pg_temp.id('biz B'), 'Takeover', 'en', 'Alice',
                               pg_temp.id('owner role B2'), pg_temp.id('owner member B2')) $$),
  '^ERROR',
  'create_business cannot take over an existing business id'
);

select is(
  pg_temp.api_value('user A', null, $$select app.is_active_member(pg_temp.id('biz A'))$$),
  'true',
  'app.is_active_member: user A is an active member of business A'
);

select is(
  pg_temp.api_value('user B', null, $$select app.is_active_member(pg_temp.id('biz A'))$$),
  'false',
  'app.is_active_member: user B is not a member of business A'
);

select is(
  pg_temp.api_value('user A', null, $$select string_agg(b::text, ',') from app.my_business_ids() as b$$),
  pg_temp.id('biz A')::text,
  'app.my_business_ids() lists only the caller''s businesses'
);

-- 3. Fixtures created through the API role (5) -----------------------------------------------

select is(pg_temp.api_exec(v.who, v.biz, v.stmt), 'ok 1', v.what)
  from (values
    ('user A', 'biz A', 'setup: business A gets a custom role',
     $$insert into app.roles (id, business_id, name, template_key)
       values (pg_temp.id('staff role A'), pg_temp.id('biz A'), 'Cashier', null)$$),
    ('user A', 'biz A', 'setup: business A gets a default location',
     $$insert into app.locations (id, business_id, name, is_default)
       values (pg_temp.id('main A'), pg_temp.id('biz A'), 'Main branch', true)$$),
    ('user A', 'biz A', 'setup: user C joins business A as an active member',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member C in A'), pg_temp.id('biz A'), pg_temp.id('user C'), 'account', 'Chris', 'active',
               pg_temp.id('staff role A'))$$),
    ('user B', 'biz B', 'setup: business B gets a custom role',
     $$insert into app.roles (id, business_id, name, template_key)
       values (pg_temp.id('staff role B'), pg_temp.id('biz B'), 'Baker', null)$$),
    ('user B', 'biz B', 'setup: business B gets a default location',
     $$insert into app.locations (id, business_id, name, is_default)
       values (pg_temp.id('location B'), pg_temp.id('biz B'), 'Bakery', true)$$)
  ) as v(who, biz, what, stmt);

-- 4. app.touch_row (11) ----------------------------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.locations (id, business_id, name, is_default, created_at, updated_at, version)
    values (pg_temp.id('old store'), pg_temp.id('biz A'), 'Old store', false,
            '2020-01-01 00:00:00+00', '2020-01-01 00:00:00+00', 1) $$),
  'ok 1',
  'setup: a location last touched in 2020'
);

select is(
  pg_temp.api_exec('user C', 'biz A', $$
    update app.locations set name = 'Old store (renamed)' where id = pg_temp.id('old store') $$),
  'ok 1',
  'member C renames it'
);

select is(
  (select format('version=%s updated_at_moved=%s created_at_kept=%s created_by_kept=%s updated_by_is_c=%s',
                 version, updated_at >= now(), created_at = '2020-01-01 00:00:00+00',
                 created_by = pg_temp.id('user A'), updated_by = pg_temp.id('user C'))
     from app.locations where id = pg_temp.id('old store')),
  'version=2 updated_at_moved=t created_at_kept=t created_by_kept=t updated_by_is_c=t',
  'touch_row bumps version and updated_at and records the updater'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$update app.locations set version = 100 where id = pg_temp.id('old store')$$),
  'ok 1',
  'an update that tries to set version itself goes through'
);

select is(
  (select version from app.locations where id = pg_temp.id('old store')),
  3,
  'touch_row sets version = old.version + 1 whatever the client sends'
);

-- Run as the table owner (no RLS): only touch_row can stop these.
select throws_like(
  $$ update app.locations set business_id = pg_temp.id('biz B') where id = pg_temp.id('old store') $$,
  '%',
  'touch_row forbids changing business_id'
);

select throws_like(
  $$ update app.locations set id = pg_temp.id('old store moved') where id = pg_temp.id('old store') $$,
  '%',
  'touch_row forbids changing id'
);

select throws_like(
  $$ update app.locations set created_by = pg_temp.id('user B') where id = pg_temp.id('old store') $$,
  '%',
  'touch_row forbids changing created_by'
);

select throws_like(
  $$ update app.locations set created_at = now() where id = pg_temp.id('old store') $$,
  '%',
  'touch_row forbids changing created_at'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.businesses set legal_name = 'Alpha Trading LLC' where id = pg_temp.id('biz A') $$),
  'ok 1',
  'owner A renames business A'
);

select is(
  (select format('%s|%s', version, updated_by = pg_temp.id('user A')) from app.businesses where id = pg_temp.id('biz A')),
  '2|t',
  'touch_row versions businesses too'
);

-- 5. CHECK and UNIQUE constraints (27) -----------------------------------------------------

-- businesses.trn: exactly 15 ASCII digits.
select matches(pg_temp.api_exec('user A', 'biz A', v.stmt), v.expected, v.what)
  from (values
    ('a TRN must have exactly 15 digits', '^ERROR 23514',
     $$update app.businesses set trn = '12345' where id = pg_temp.id('biz A')$$),
    ('a TRN must use ASCII digits (the domain layer normalizes Arabic-Indic digits first)', '^ERROR 23514',
     $$update app.businesses set trn = repeat(chr(1633), 15) where id = pg_temp.id('biz A')$$),
    ('a 15-digit TRN is accepted', '^ok 1$',
     $$update app.businesses set trn = '100000000000003' where id = pg_temp.id('biz A')$$)
  ) as v(what, expected, stmt);

-- business_members: kind, user_id, status, display_name, one live membership per user.
select matches(pg_temp.api_exec('user A', 'biz A', v.stmt), v.expected, v.what)
  from (values
    ('a pin_only member cannot have a user_id', '^ERROR 23514',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member x1'), pg_temp.id('biz A'), pg_temp.id('user D'), 'pin_only', 'Dana', 'active',
               pg_temp.id('staff role A'))$$),
    ('an account member must have a user_id', '^ERROR 23514',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member x2'), pg_temp.id('biz A'), null, 'account', 'Eve', 'active',
               pg_temp.id('staff role A'))$$),
    ('a pin_only member without a login is allowed', '^ok 1$',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id, pin_hash)
       values (pg_temp.id('member pin A'), pg_temp.id('biz A'), null, 'pin_only', 'Counter', 'active',
               pg_temp.id('staff role A'), 'pin-hash-secret-value')$$),
    ('member kind is account or pin_only', '^ERROR 23514',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member x3'), pg_temp.id('biz A'), pg_temp.id('user D'), 'robot', 'Dana', 'active',
               pg_temp.id('staff role A'))$$),
    ('member status is invited, active, suspended or removed', '^ERROR 23514',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member x4'), pg_temp.id('biz A'), pg_temp.id('user D'), 'account', 'Dana', 'paused',
               pg_temp.id('staff role A'))$$),
    ('every member has a display name', '^ERROR 23502',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member x5'), pg_temp.id('biz A'), pg_temp.id('user D'), 'account', null, 'active',
               pg_temp.id('staff role A'))$$),
    ('a user has at most one live membership per business', '^ERROR 23505',
     $$insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
       values (pg_temp.id('member C twice'), pg_temp.id('biz A'), pg_temp.id('user C'), 'account', 'Chris', 'active',
               pg_temp.id('staff role A'))$$)
  ) as v(what, expected, stmt);

-- Capabilities, modules, role permissions, overrides.
select matches(pg_temp.api_exec('user A', 'biz A', v.stmt), v.expected, v.what)
  from (values
    ('vat_registered is read from businesses, never stored as a capability', '^ERROR 23514',
     $$insert into app.business_capabilities (id, business_id, key, enabled, source)
       values (pg_temp.id('capability vat'), pg_temp.id('biz A'), 'vat_registered', true, 'setup')$$),
    ('a capability is stored once', '^ok 1$',
     $$insert into app.business_capabilities (id, business_id, key, enabled, source)
       values (pg_temp.id('capability A1'), pg_temp.id('biz A'), 'multi_location', true, 'setup')$$),
    ('one row per capability key and business', '^ERROR 23505',
     $$insert into app.business_capabilities (id, business_id, key, enabled, source)
       values (pg_temp.id('capability A2'), pg_temp.id('biz A'), 'multi_location', false, 'user')$$),
    ('a module is enabled once', '^ok 1$',
     $$insert into app.business_modules (id, business_id, module_key, enabled, enabled_at, enabled_by)
       values (pg_temp.id('module A1'), pg_temp.id('biz A'), 'dashboard', true, now(), pg_temp.id('user A'))$$),
    ('one row per module key and business', '^ERROR 23505',
     $$insert into app.business_modules (id, business_id, module_key, enabled, enabled_at, enabled_by)
       values (pg_temp.id('module A2'), pg_temp.id('biz A'), 'dashboard', false, now(), pg_temp.id('user A'))$$),
    ('a role gets a permission', '^ok 1$',
     $$insert into app.role_permissions (id, business_id, role_id, permission_key)
       values (pg_temp.id('permission A1'), pg_temp.id('biz A'), pg_temp.id('staff role A'), 'settings.business.view')$$),
    ('one row per role and permission key', '^ERROR 23505',
     $$insert into app.role_permissions (id, business_id, role_id, permission_key)
       values (pg_temp.id('permission A2'), pg_temp.id('biz A'), pg_temp.id('staff role A'), 'settings.business.view')$$),
    ('an override is allow or deny', '^ERROR 23514',
     $$insert into app.member_permission_overrides (id, business_id, member_id, permission_key, effect)
       values (pg_temp.id('override maybe'), pg_temp.id('biz A'), pg_temp.id('member C in A'), 'settings.business.edit', 'maybe')$$)
  ) as v(what, expected, stmt);

-- locations: one live default per business (in business B).
select matches(pg_temp.api_exec('user B', 'biz B', v.stmt), v.expected, v.what)
  from (values
    ('a business has at most one default location', '^ERROR 23505',
     $$insert into app.locations (id, business_id, name, is_default)
       values (pg_temp.id('second default B'), pg_temp.id('biz B'), 'Second', true)$$),
    ('setup: the default location is soft-deleted', '^ok 1$',
     $$update app.locations set deleted_at = now() where id = pg_temp.id('location B')$$),
    ('a soft-deleted default does not block a new default', '^ok 1$',
     $$insert into app.locations (id, business_id, name, is_default)
       values (pg_temp.id('new default B'), pg_temp.id('biz B'), 'New bakery', true)$$)
  ) as v(what, expected, stmt);

-- profiles.locale
select matches(
  pg_temp.api_exec('user A', null, $$
    insert into app.profiles (id, display_name, locale) values (pg_temp.id('user A'), 'Alice', 'fr') $$),
  '^ERROR 23514',
  'profile locale is en or ar'
);

-- business_invitations: one pending per email, global token_hash, status values.
select matches(pg_temp.api_exec(v.who, v.biz, v.stmt), v.expected, v.what)
  from (values
    ('user A', 'biz A', 'a pending invitation', '^ok 1$',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('invitation dup 1'), pg_temp.id('biz A'), 'dup@example.test',
               encode(sha256(convert_to('token dup 1', 'UTF8')), 'hex'), now() + interval '7 days', 'pending',
               pg_temp.id('staff role A'), '{}', array[]::uuid[], 1, now())$$),
    ('user A', 'biz A', 'one pending invitation per email and business (case-insensitive)', '^ERROR 23505',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('invitation dup 2'), pg_temp.id('biz A'), 'DUP@Example.TEST',
               encode(sha256(convert_to('token dup 2', 'UTF8')), 'hex'), now() + interval '7 days', 'pending',
               pg_temp.id('staff role A'), '{}', array[]::uuid[], 1, now())$$),
    ('user A', 'biz A', 'non-pending invitations for the same email are allowed', '^ok 1$',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('invitation dup 3'), pg_temp.id('biz A'), 'dup@example.test',
               encode(sha256(convert_to('token dup 3', 'UTF8')), 'hex'), now() + interval '7 days', 'revoked',
               pg_temp.id('staff role A'), '{}', array[]::uuid[], 1, now())$$),
    ('user B', 'biz B', 'token_hash is unique across all businesses', '^ERROR 23505',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('invitation dup 4'), pg_temp.id('biz B'), 'dup@example.test',
               encode(sha256(convert_to('token dup 1', 'UTF8')), 'hex'), now() + interval '7 days', 'pending',
               pg_temp.id('staff role B'), '{}', array[]::uuid[], 1, now())$$),
    ('user A', 'biz A', 'invitation status is pending, accepted, revoked or expired', '^ERROR 23514',
     $$insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                             overrides, location_ids, send_count, last_sent_at)
       values (pg_temp.id('invitation odd'), pg_temp.id('biz A'), 'odd@example.test',
               encode(sha256(convert_to('token odd', 'UTF8')), 'hex'), now() + interval '7 days', 'sent',
               pg_temp.id('staff role A'), '{}', array[]::uuid[], 1, now())$$)
  ) as v(who, biz, what, expected, stmt);

-- 6. app.accept_invitation (22) ------------------------------------------------------------

select is(
  pg_temp.api_exec('user I', null, $$
    insert into app.profiles (id, display_name, locale) values (pg_temp.id('user I'), 'Ivy', 'en') $$),
  'ok 1',
  'setup: the invitee has a profile named Ivy'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
    values (pg_temp.id('member Q'), pg_temp.id('biz A'), pg_temp.id('user Q'), 'account', 'Quinn', 'removed',
            pg_temp.id('owner role A')) $$),
  'ok 1',
  'setup: Quinn is a removed member who used to hold the Owner role'
);

-- Tokens are 'token <who>'; the table stores only sha256 hex of the token.
select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status, role_id,
                                          overrides, location_ids, send_count, last_sent_at)
    select pg_temp.id('invitation ' || v.who), pg_temp.id('biz A'), v.email,
           encode(sha256(convert_to('token ' || v.who, 'UTF8')), 'hex'), now() + v.ttl, v.status,
           pg_temp.id('staff role A'), v.overrides::jsonb, v.locations, 1, now()
      from (values
        ('ivy',   'Ivy@Example.test',       interval '7 days', 'pending',
         '{"settings.members.view": "allow", "settings.roles.edit": "deny"}', array[pg_temp.id('main A')]),
        ('jay',   'jay.smith@example.test', interval '7 days', 'pending', '{}', array[]::uuid[]),
        ('quinn', 'quinn@example.test',     interval '7 days', 'pending', '{}', array[]::uuid[]),
        ('una',   'una@example.test',       interval '7 days', 'pending', '{}', array[]::uuid[]),
        ('lena',  'lena@example.test',      interval '-1 day', 'pending', '{}', array[]::uuid[]),
        ('rami',  'rami@example.test',      interval '7 days', 'revoked', '{}', array[]::uuid[]),
        ('xena',  'xena@example.test',      interval '7 days', 'pending', '{}', array[pg_temp.id('new default B')])
      ) as v(who, email, ttl, status, overrides, locations) $$),
  'ok 7',
  'setup: business A sends seven invitations'
);

create temp table generic_error as
  select pg_temp.api_value('user W', null, $$
    select app.accept_invitation('no-such-token', pg_temp.id('member W')) $$) as msg;

select matches((select msg from generic_error), '^ERROR', 'an unknown token is rejected');

select is(
  pg_temp.api_value('user W', null, $$select app.accept_invitation('token ivy', pg_temp.id('member W'))$$),
  (select msg from generic_error),
  'a valid token used by another verified account fails with the same generic error'
);

select is(
  pg_temp.api_value('user U', null, $$select app.accept_invitation('token una', pg_temp.id('member U'))$$),
  (select msg from generic_error),
  'an unverified email cannot accept (same generic error)'
);

select is(
  pg_temp.api_value('user L', null, $$select app.accept_invitation('token lena', pg_temp.id('member L'))$$),
  (select msg from generic_error),
  'an expired invitation cannot be accepted (same generic error)'
);

select is(
  pg_temp.api_value('user R', null, $$select app.accept_invitation('token rami', pg_temp.id('member R'))$$),
  (select msg from generic_error),
  'a revoked invitation cannot be accepted (same generic error)'
);

select matches(
  pg_temp.api_value('user X', null, $$select app.accept_invitation('token xena', pg_temp.id('member X'))$$),
  '^ERROR',
  'an invitation scoped to another business''s location is rejected'
);

select is(
  (select status::text from app.business_invitations where id = pg_temp.id('invitation ivy')),
  'pending',
  'failed attempts leave the invitation pending'
);

select is_empty(
  $$ select user_id from app.business_members
      where business_id = pg_temp.id('biz A')
        and user_id in (pg_temp.id('user W'), pg_temp.id('user U'), pg_temp.id('user L'),
                        pg_temp.id('user R'), pg_temp.id('user X')) $$,
  'failed attempts create no membership'
);

select is(
  pg_temp.api_value('user I', null, $$select app.accept_invitation('token ivy', pg_temp.id('member I'))$$),
  pg_temp.id('biz A')::text,
  'the invitee accepts: the verified email matches the invitation case-insensitively'
);

select results_eq(
  $$ select user_id, kind::text, status::text, role_id, display_name::text
       from app.business_members
      where business_id = pg_temp.id('biz A') and user_id = pg_temp.id('user I') $$,
  $$ values (pg_temp.id('user I'), 'account', 'active', pg_temp.id('staff role A'), 'Ivy') $$,
  'acceptance creates one active account membership with the invited role and the profile name'
);

select results_eq(
  $$ select o.permission_key::text, o.effect::text
       from app.member_permission_overrides o
       join app.business_members m on m.business_id = o.business_id and m.id = o.member_id
      where m.business_id = pg_temp.id('biz A') and m.user_id = pg_temp.id('user I')
      order by 1 $$,
  $$ values ('settings.members.view', 'allow'), ('settings.roles.edit', 'deny') $$,
  'acceptance applies the invitation''s permission overrides'
);

select results_eq(
  $$ select l.location_id
       from app.member_locations l
       join app.business_members m on m.business_id = l.business_id and m.id = l.member_id
      where m.business_id = pg_temp.id('biz A') and m.user_id = pg_temp.id('user I') $$,
  $$ values (pg_temp.id('main A')) $$,
  'acceptance applies the invitation''s location scope'
);

select is(
  (select status::text from app.business_invitations where id = pg_temp.id('invitation ivy')),
  'accepted',
  'the invitation is marked accepted'
);

select is(
  pg_temp.api_value('user I', null, $$select app.accept_invitation('token ivy', pg_temp.id('member I again'))$$),
  (select msg from generic_error),
  'an accepted invitation cannot be used again (same generic error)'
);

select is(
  pg_temp.api_value('user I', 'biz A', $$select count(*) from app.locations where id = pg_temp.id('main A')$$),
  '1',
  'the new member can read business A right away'
);

select is(
  pg_temp.api_value('user J', null, $$select app.accept_invitation('token jay', pg_temp.id('member J'))$$),
  pg_temp.id('biz A')::text,
  'an invitee without a profile can accept'
);

select is(
  (select display_name::text from app.business_members
    where business_id = pg_temp.id('biz A') and user_id = pg_temp.id('user J')),
  'jay.smith',
  'without a profile the display name falls back to the email local part'
);

select is(
  pg_temp.api_value('user Q', null, $$select app.accept_invitation('token quinn', pg_temp.id('member Q again'))$$),
  pg_temp.id('biz A')::text,
  'a removed member can accept a new invitation'
);

select is(
  (select format('%s|%s|%s', count(*), min(status), bool_and(role_id = pg_temp.id('staff role A')))
     from app.business_members
    where business_id = pg_temp.id('biz A') and user_id = pg_temp.id('user Q') and deleted_at is null),
  '1|active|t',
  'the old membership is re-activated with the invited role, not duplicated'
);

-- 7. app.audit_row (15) ------------------------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.locations (id, business_id, name, is_default)
    values (pg_temp.id('audit room'), pg_temp.id('biz A'), 'Audit room', false) $$,
    'request audit insert'),
  'ok 1',
  'setup: owner A adds a location under a known request id'
);

select is(
  (select format('%s|%s|%s|%s|%s|%s', action, entity, business_id = pg_temp.id('biz A'),
                 actor_user_id = pg_temp.id('user A'), (changes ? 'after') and not (changes ? 'before'),
                 changes -> 'after' ->> 'name')
     from app.audit_log
    where request_id = pg_temp.id('request audit insert') and entity_id = pg_temp.id('audit room')),
  'insert|locations|t|t|t|Audit room',
  'an insert is audited with business, actor, request id and the new row'
);

select is(
  pg_temp.api_exec('user C', 'biz A', $$
    update app.locations set name = 'Audit room 2' where id = pg_temp.id('audit room') $$,
    'request audit update'),
  'ok 1',
  'setup: member C renames it under another request id'
);

select is(
  (select format('%s|%s|%s|%s', action, actor_user_id = pg_temp.id('user C'),
                 changes -> 'before' ->> 'name', changes -> 'after' ->> 'name')
     from app.audit_log
    where request_id = pg_temp.id('request audit update') and entity_id = pg_temp.id('audit room')),
  'update|t|Audit room|Audit room 2',
  'an update is audited with the row before and after'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$delete from app.role_permissions where id = pg_temp.id('permission A1')$$,
                   'request audit delete'),
  'ok 1',
  'setup: owner A revokes a role permission'
);

select is(
  (select format('%s|%s|%s', action, changes ? 'before', changes ? 'after')
     from app.audit_log
    where request_id = pg_temp.id('request audit delete') and entity_id = pg_temp.id('permission A1')),
  'delete|t|f',
  'a delete is audited with the old row only'
);

select is(
  (select format('%s|%s|%s', business_id = entity_id, actor_user_id = pg_temp.id('user A'), request_id is not null)
     from app.audit_log
    where entity = 'businesses' and entity_id = pg_temp.id('biz A') and action = 'insert'),
  't|t|t',
  'creating a business is audited under the business itself, with actor and request id'
);

select is_empty(
  $$ select id, entity, action from app.audit_log
      where business_id in (pg_temp.id('biz A'), pg_temp.id('biz B'))
        and (actor_user_id is null or request_id is null) $$,
  'every audit row carries an actor and a request id'
);

select isnt_empty(
  $$ select id from app.audit_log where entity = 'business_invitations' and business_id = pg_temp.id('biz A') $$,
  'invitation writes are audited'
);

select is_empty(
  $$ select a.id from app.audit_log a
      where a.changes::text like '%token_hash%'
         or exists (select 1 from app.business_invitations i where strpos(a.changes::text, i.token_hash) > 0) $$,
  'audit rows never contain token_hash (neither the key nor a value)'
);

select isnt_empty(
  $$ select id from app.audit_log where entity = 'business_members' and entity_id = pg_temp.id('member pin A') $$,
  'member writes are audited'
);

select is_empty(
  $$ select id from app.audit_log
      where changes::text like '%pin_hash%' or strpos(changes::text, 'pin-hash-secret-value') > 0 $$,
  'audit rows never contain pin_hash (neither the key nor a value)'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$update app.audit_log set action = action$$),
  '^ERROR 42501',
  'bizcost_api cannot update audit_log'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$delete from app.audit_log$$),
  '^ERROR 42501',
  'bizcost_api cannot delete from audit_log'
);

select is(
  (select string_agg(distinct actor_user_id::text, ',')
     from app.audit_log
    where entity = 'business_members' and action = 'insert'
      and entity_id in (select id from app.business_members where user_id = pg_temp.id('user I'))),
  pg_temp.id('user I')::text,
  'accepting an invitation is audited with the invitee as actor'
);

-- 8. At least one active Owner (15) ---------------------------------------------------------
-- Business A: user A is the only active account member with the Owner role.

select matches(pg_temp.api_exec('user A', 'biz A', v.stmt), '^ERROR', v.what)
  from (values
    ('the last active owner cannot be suspended',
     $$update app.business_members set status = 'suspended' where id = pg_temp.id('owner member A')$$),
    ('the last active owner cannot be removed',
     $$update app.business_members set status = 'removed' where id = pg_temp.id('owner member A')$$),
    ('the last active owner cannot be soft-deleted',
     $$update app.business_members set deleted_at = now() where id = pg_temp.id('owner member A')$$),
    ('the last active owner cannot be deleted',
     $$delete from app.business_members where id = pg_temp.id('owner member A')$$),
    ('the last active owner cannot be demoted',
     $$update app.business_members set role_id = pg_temp.id('staff role A') where id = pg_temp.id('owner member A')$$),
    ('the Owner role cannot lose its owner template while it holds the last owner',
     $$update app.roles set template_key = null where id = pg_temp.id('owner role A')$$)
  ) as v(what, stmt);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.business_members (id, business_id, user_id, kind, display_name, status, role_id)
    values (pg_temp.id('pin owner A'), pg_temp.id('biz A'), null, 'pin_only', 'Shared tablet', 'active',
            pg_temp.id('owner role A')) $$),
  'ok 1',
  'setup: a pin-only member holding the Owner role'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set status = 'suspended' where id = pg_temp.id('owner member A') $$),
  '^ERROR',
  'a pin-only owner does not count: the last account owner still cannot be suspended'
);

select is(
  (select format('%s|%s|%s', status, deleted_at is null, role_id = pg_temp.id('owner role A'))
     from app.business_members where id = pg_temp.id('owner member A')),
  'active|t|t',
  'the owner membership is unchanged after the rejected changes'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set role_id = pg_temp.id('owner role A') where id = pg_temp.id('member C in A') $$),
  'ok 1',
  'owner A promotes member C to Owner'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set status = 'suspended' where id = pg_temp.id('owner member A') $$),
  'ok 1',
  'with a second active owner, the first one can be suspended'
);

select matches(
  pg_temp.api_exec('user C', 'biz A', $$
    update app.business_members set status = 'suspended' where id = pg_temp.id('member C in A') $$),
  '^ERROR',
  'member C is now the last active owner and cannot suspend itself'
);

select is(
  pg_temp.api_exec('user B', 'biz B', $$
    update app.businesses set deleted_at = now() where id = pg_temp.id('biz B') $$),
  'ok 1',
  'setup: owner B soft-deletes business B'
);

select is(
  pg_temp.api_exec('user B', 'biz B', $$
    update app.business_members set status = 'suspended' where id = pg_temp.id('owner member B') $$),
  'ok 1',
  'a soft-deleted business is exempt from the owner rule'
);

-- Checked as the test owner: nobody is an active member of business B any more.
select throws_ok(
  $$ update app.businesses set deleted_at = null where id = pg_temp.id('biz B') $$,
  '23514',
  null,
  'restoring a soft-deleted business without an active account owner is rejected'
);

select * from finish();
rollback;
