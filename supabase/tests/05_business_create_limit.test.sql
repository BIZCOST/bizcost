-- pgTAP: the business creation limit of app.create_business (Milestone 1, Step 5): at most 10
-- businesses per user in 24 hours, soft-deleted ones included, counted per user.
-- Statements under test run as bizcost_api with tenant context, like the API does.
begin;
select plan(8);

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

-- Readable, deterministic fixture ids: pg_temp.id('biz A1') is always the same uuid.
create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5(p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

-- Runs p_sql as bizcost_api for the user (fixture name) and returns the first column of the first
-- row as text, or 'ERROR <sqlstate>: <message>'.
create function pg_temp.api_value(p_user text, p_sql text)
returns text
language plpgsql
as $$
declare
  v_out text;
begin
  perform set_config('app.user_id', pg_temp.id(p_user)::text, true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    execute p_sql into v_out;
  exception when others then
    v_out := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  perform set_config('app.user_id', '', true);
  perform set_config('app.request_id', '', true);
  return v_out;
end
$$;

-- Creates business '<user> <n>' as the user; returns its id or the error.
create function pg_temp.create_for(p_user text, p_n int)
returns text
language sql
as $$
  select pg_temp.api_value(p_user, format(
    $f$select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner', pg_temp.id(%L), pg_temp.id(%L))$f$,
    p_user || ' biz ' || p_n, p_user || ' biz ' || p_n,
    p_user || ' role ' || p_n, p_user || ' member ' || p_n))
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values
    ('user A', 'limit-a@example.test'),
    ('user B', 'limit-b@example.test'),
    ('user C', 'limit-c@example.test')
  ) as u(name, email);

select is(
  (select count(*)::int from generate_series(1, 10) as n
    where pg_temp.create_for('user A', n) = pg_temp.id('user A biz ' || n)::text),
  10,
  'a user creates 10 businesses in 24 hours'
);

select is(
  pg_temp.create_for('user A', 11),
  'ERROR BZ429: business_create_limit: at most 10 businesses per user in 24 hours',
  'the 11th within 24 hours is refused with SQLSTATE BZ429'
);

select is_empty(
  $$ select id from app.businesses where id = pg_temp.id('user A biz 11') $$,
  'nothing of the refused business is written'
);

select is(
  pg_temp.create_for('user B', 1),
  pg_temp.id('user B biz 1')::text,
  'the limit is per user'
);

update app.businesses set deleted_at = now() where id = pg_temp.id('user A biz 1');
select matches(
  pg_temp.create_for('user A', 12),
  '^ERROR BZ429',
  'soft-deleted businesses still count'
);

-- User C created 10 businesses 25 hours ago (written directly, as the migration owner).
insert into app.businesses (id, legal_name, default_locale, created_by, created_at)
select pg_temp.id('user C old ' || n), 'Old ' || n, 'en', pg_temp.id('user C'),
       now() - interval '25 hours'
  from generate_series(1, 10) as n;

select is(
  pg_temp.create_for('user C', 1),
  pg_temp.id('user C biz 1')::text,
  'businesses created more than 24 hours ago no longer count'
);

select is_definer(
  'app', 'create_business', array['uuid', 'text', 'text', 'text', 'uuid', 'uuid']::name[],
  'app.create_business(...) is still SECURITY DEFINER'
);

select ok(
  (select 'search_path=""' = any (p.proconfig)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'create_business'),
  'app.create_business(...) still sets an empty search_path'
);

select * from finish();
rollback;
