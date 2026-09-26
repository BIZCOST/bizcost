-- pgTAP: the business's Arabic name on the invitation page (D-097): app.preview_invitation returns
-- businesses.legal_name_ar next to the legal name (null when the business has none or it is blank),
-- keeps its checks, and stays SECURITY DEFINER, owned by postgres and executable by bizcost_api only
-- after being created again. Statements under test run as bizcost_api, like the API does.
begin;
select plan(9);

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
as $$ select md5(p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

-- Runs p_sql as bizcost_api with the given user/business (fixture names; null = unset). Returns
-- the first column of the first row, or 'ERROR <sqlstate>: <message>'.
create function pg_temp.api_value(p_user text, p_business text, p_sql text)
returns text
language plpgsql
as $$
declare
  v_out text;
begin
  perform set_config('app.user_id', coalesce(pg_temp.id(p_user)::text, ''), true);
  perform set_config('app.business_id', coalesce(pg_temp.id(p_business)::text, ''), true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    execute p_sql into v_out;
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
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user N'), 'authenticated',
        'authenticated', 'noor@example.test', now(), '{}', '{}', now(), now());

-- 1. The function after it was created again (3) ------------------------------------------------

select is_definer('app', 'preview_invitation', array['text']::name[],
                  'app.preview_invitation(text) is still SECURITY DEFINER');
select is(
  (select pg_get_userbyid(p.proowner) from pg_proc p
    where p.oid = 'app.preview_invitation(text)'::regprocedure),
  'postgres',
  'app.preview_invitation(text) is still owned by postgres'
);
select ok(
  has_function_privilege('bizcost_api', 'app.preview_invitation(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.preview_invitation(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.preview_invitation(text)', 'EXECUTE')
  and not has_function_privilege('public', 'app.preview_invitation(text)', 'EXECUTE'),
  'only bizcost_api may run app.preview_invitation'
);

-- 2. Fixtures: business N and a pending invitation ('token nia') -----------------------------------

select is(
  pg_temp.api_value('user N', null, $$
    select app.create_business(pg_temp.id('biz N'), 'Noor Bakery', 'en', 'Noor',
                               pg_temp.id('owner role N'), pg_temp.id('member N')) $$),
  pg_temp.id('biz N')::text,
  'setup: user N creates business N'
);

select is(
  pg_temp.api_value('user N', 'biz N', $$
    with role as (
      insert into app.roles (id, business_id, name, template_key)
      values (pg_temp.id('staff role N'), pg_temp.id('biz N'), 'Employee', 'employee')
      returning id
    )
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status,
                                          role_id, locale, send_count, last_sent_at)
    select pg_temp.id('invitation nia'), pg_temp.id('biz N'), 'nia@example.test',
           encode(sha256(convert_to('token nia', 'UTF8')), 'hex'), now() + interval '7 days',
           'pending', role.id, 'ar', 1, now()
      from role
    returning id::text $$),
  pg_temp.id('invitation nia')::text,
  'setup: an invitation to business N'
);

-- 3. The Arabic name (4) ----------------------------------------------------------------------

select is(
  pg_temp.api_value('user N', 'biz N', $$
    update app.businesses set legal_name_ar = '   ' where id = pg_temp.id('biz N')
    returning id::text $$),
  pg_temp.id('biz N')::text,
  'setup: a blank Arabic name'
);

select is(
  pg_temp.api_value(null, null, $$
    select format('%s|%s|%s', business_name, coalesce(business_name_ar, 'null'), masked_email)
      from app.preview_invitation('token nia') $$),
  'Noor Bakery|null|n•••@example.test',
  'without an Arabic name (or a blank one) the preview has none'
);

select is(
  pg_temp.api_value('user N', 'biz N', $$
    update app.businesses set legal_name_ar = 'مخبز النور' where id = pg_temp.id('biz N')
    returning id::text $$),
  pg_temp.id('biz N')::text,
  'setup: the owner saves the Arabic name'
);

select is(
  pg_temp.api_value(null, null, $$
    select format('%s|%s', business_name, business_name_ar)
      from app.preview_invitation('token nia') $$),
  'Noor Bakery|مخبز النور',
  'the preview has the business''s Arabic name next to its legal name'
);

select * from finish();
rollback;
