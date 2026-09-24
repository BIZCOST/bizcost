-- pgTAP (attack, regression): bizcost_api must not be able to forge audit_log rows.
-- D8 writes every audit row from the SECURITY DEFINER trigger app.audit_row(), which does not need
-- any privilege of the caller. With INSERT on app.audit_log (as first planned in D1c) and the
-- standard tenant policy, a member could append rows that name another user as the actor, use any
-- action/entity/entity_id, and backdate created_at, so the audit log could not be trusted to show
-- who did what.
-- Fixed: bizcost_api holds SELECT only on audit_log (DECISIONS.md D-050).
begin;
select plan(4);

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
as $$ select md5('attack audit ' || p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

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
  from (values ('owner', 'owner.audit@example.test'),
               ('staff', 'staff.audit@example.test')) as u(name, email);

select is(
  pg_temp.api_exec('owner', null, $$
    select app.create_business(pg_temp.id('biz'), 'Audit Trading', 'en', 'Owner',
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
  'setup: owner adds an active staff member'
);

-- Attack: staff writes an audit row blaming the owner for a delete that never happened, 30 days ago.
select matches(
  pg_temp.api_exec('staff', 'biz', $$
    insert into app.audit_log (id, business_id, actor_user_id, action, entity, entity_id, request_id,
                               changes, created_at)
    values (pg_temp.id('forged row'), pg_temp.id('biz'), pg_temp.id('owner'), 'delete', 'business_members',
            pg_temp.id('staff member'), null, '{"before": {"note": "forged"}}', now() - interval '30 days') $$),
  '^ERROR 42501',
  'bizcost_api cannot insert audit rows directly (only the audit trigger writes them)'
);

select is_empty(
  $$ select id from app.audit_log
      where id = pg_temp.id('forged row')
         or (business_id = pg_temp.id('biz') and changes -> 'before' ->> 'note' = 'forged') $$,
  'the forged row (owner named as actor, backdated) is not in the audit log'
);

select * from finish();
rollback;
