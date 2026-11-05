-- pgTAP: the closed beta (D-355, D-356, D-357): the Auth hook auth_hooks.before_user_created, who reaches
-- the beta list and the feedback, and the rules on feedback that hold whatever the API does. Statements
-- under test run as bizcost_api with tenant context, like the API does; Storage writes run as the test's
-- own role, like Storage. Real Auth, with the hook on, and the API: beta.api.test.ts.
begin;
select plan(65);

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

create function pg_temp.api_run(p_user text, p_business text, p_sql text, p_scalar boolean)
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
    if p_scalar then
      execute p_sql into v_out;
    else
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_out := 'ok ' || v_rows;
    end if;
  exception when others then
    v_out := 'ERROR ' || sqlstate;
  end;
  reset role;
  perform set_config('app.user_id', '', true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.request_id', '', true);
  return v_out;
end
$$;

create function pg_temp.api_exec(p_user text, p_business text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, false) $$;

create function pg_temp.api_value(p_user text, p_business text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, true) $$;

-- The hook's answer for an address, as Auth calls it with the event. (The Auth role itself: its
-- privileges are read below; a test cannot take that role.)
create function pg_temp.hook(p_email text) returns jsonb
language plpgsql
as $$
begin
  return auth_hooks.before_user_created(
    jsonb_build_object('metadata', '{}'::jsonb,
                       'user', jsonb_build_object('email', p_email, 'aud', 'authenticated'))
  );
end
$$;

create function pg_temp.storage_put(p_name text) returns text
language plpgsql
as $$
begin
  insert into storage.objects (bucket_id, name, metadata)
  values ('business-files', p_name, '{"mimetype": "image/png"}');
  return 'ok';
exception when others then
  return 'ERROR ' || sqlstate;
end
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, u.confirmed, '{}', '{}', now(), now()
  from (values
    ('user A', 'amal.beta@example.test', now()),
    ('user X', 'xena.beta@example.test', now()),
    ('user W', 'walt.beta@example.test', now()),
    ('user U', 'unconfirmed.beta@example.test', null)
  ) as u(name, email, confirmed);

select is(
  pg_temp.api_value('user A', null, $$
    select app.create_business(pg_temp.id('biz A'), 'Amal Bakery', 'en', 'Amal',
                               pg_temp.id('owner role A'), pg_temp.id('member A')) $$),
  pg_temp.id('biz A')::text,
  'setup: user A creates business A'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.roles (id, business_id, name, template_key) values
      (pg_temp.id('admin role A'), pg_temp.id('biz A'), 'Admin', 'admin'),
      (pg_temp.id('staff role A'), pg_temp.id('biz A'), 'Employee', 'employee');
    insert into app.role_permissions (id, business_id, role_id, permission_key) values
      (pg_temp.id('rp 2'), pg_temp.id('biz A'), pg_temp.id('admin role A'), 'settings.members.manage');
    insert into app.business_members (id, business_id, user_id, kind, display_name, email, status, role_id)
    values (pg_temp.id('member X'), pg_temp.id('biz A'), pg_temp.id('user X'), 'account', 'Xena',
            'xena.beta@example.test', 'active', pg_temp.id('admin role A')) $$),
  'ok 1',
  'setup: roles and Xena, who may invite'
);

create function pg_temp.invite(p_key text, p_email text, p_as text, p_expires interval)
returns text language sql
as $$
  select pg_temp.api_exec(p_as, 'biz A', format($f$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id,
                                          send_count, last_sent_at)
    values (pg_temp.id(%1$L), pg_temp.id('biz A'), %2$L,
            encode(sha256(convert_to(%1$L, 'UTF8')), 'hex'), now() + %3$L::interval,
            pg_temp.id('staff role A'), 1, now()) $f$, p_key, p_email, p_expires::text))
$$;

-- 1. Who reaches the hook, and what it can reach ----------------------------------------------------

select ok(has_schema_privilege('supabase_auth_admin', 'auth_hooks', 'USAGE'),
          'the Auth role can use schema auth_hooks');
select ok(not has_schema_privilege('supabase_auth_admin', 'app', 'USAGE'),
          'the Auth role has nothing on schema app: the hook is SECURITY DEFINER');
select ok(not has_schema_privilege('anon', 'auth_hooks', 'USAGE')
          and not has_schema_privilege('authenticated', 'auth_hooks', 'USAGE')
          and not has_schema_privilege('bizcost_api', 'auth_hooks', 'USAGE'),
          'anon, authenticated and bizcost_api have nothing on schema auth_hooks');
select ok(has_function_privilege('supabase_auth_admin', 'auth_hooks.before_user_created(jsonb)', 'EXECUTE'),
          'the Auth role may call the hook');
select ok(not has_function_privilege('anon', 'auth_hooks.before_user_created(jsonb)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'auth_hooks.before_user_created(jsonb)', 'EXECUTE')
          and not has_function_privilege('bizcost_api', 'auth_hooks.before_user_created(jsonb)', 'EXECUTE')
          and not has_function_privilege('public', 'auth_hooks.before_user_created(jsonb)', 'EXECUTE'),
          'nobody else may');
select ok(not has_function_privilege('bizcost_api', 'app.signup_allowed(text)', 'EXECUTE')
          and not has_function_privilege('anon', 'app.signup_allowed(text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app.signup_allowed(text)', 'EXECUTE'),
          'who may sign up cannot be asked of the database by anyone but the hook');
select is_definer('auth_hooks', 'before_user_created', array['jsonb']::name[],
                  'the hook runs as its owner');
select ok(
  (select proconfig @> array['search_path=""'] from pg_proc
    where oid = 'auth_hooks.before_user_created(jsonb)'::regprocedure),
  'the hook pins its search_path'
);

-- 2. Its answers --------------------------------------------------------------------------------------

select is(pg_temp.hook('stranger@example.test'),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'an address on no list is refused, with the one message the app knows');
select is(pg_temp.hook(null),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'no address (a phone, an anonymous user) is refused');
select is(pg_temp.hook('   '),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'a blank address is refused');
select is(
  (select auth_hooks.before_user_created('{}'::jsonb)),
  '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
  'an event with no user is refused'
);

insert into app.beta_list (email, note) values ('listed@example.test', 'from the SQL editor');
select is(pg_temp.hook('listed@example.test'), '{}'::jsonb, 'an address on the list goes on');
select is(pg_temp.hook('LISTED@Example.Test'), '{}'::jsonb, 'in any case');
select is(pg_temp.hook(' listed@example.test '), '{}'::jsonb, 'with spaces around it');
select is(pg_temp.hook('listed@example.test.evil.example'),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'an address that only starts like it is refused');
select is(pg_temp.hook('%@example.test'),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'a wildcard matches nothing');

update app.beta_list set removed_at = now() where email::text = 'listed@example.test';
select is(pg_temp.hook('listed@example.test'),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'taken off the list, it is refused');

select is(pg_temp.invite('invited', 'invited@example.test', 'user A', '7 days'), 'ok 1',
          'setup: an invitation from the owner');
select is(pg_temp.hook('invited@example.test'), '{}'::jsonb, 'a pending invitation lets its address in');
select is(pg_temp.hook('INVITED@example.test'), '{}'::jsonb, 'in any case');

select is(pg_temp.invite('late', 'late@example.test', 'user A', '-1 minute'), 'ok 1',
          'setup: an invitation already expired');
select is(pg_temp.hook('late@example.test'),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'an expired invitation does not');

select is(pg_temp.invite('from x', 'fromx@example.test', 'user X', '7 days'), 'ok 1',
          'setup: an invitation from Xena, who may invite');
select is(pg_temp.hook('fromx@example.test'), '{}'::jsonb, 'it lets its address in');
select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.member_permission_overrides (id, business_id, member_id, permission_key, effect)
    values (pg_temp.id('deny x'), pg_temp.id('biz A'), pg_temp.id('member X'),
            'settings.members.manage', 'deny') $$),
  'ok 1',
  'setup: Xena may no longer invite'
);
select is(pg_temp.hook('fromx@example.test'),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'then her invitation does not, as it could not be accepted');

update app.business_invitations set status = 'revoked' where id = pg_temp.id('invited');
select is(pg_temp.hook('invited@example.test'),
          '{"error": {"http_code": 403, "message": "beta_invite_only"}}'::jsonb,
          'a revoked invitation does not');

-- 3. The beta list: nothing but the functions ---------------------------------------------------------

select is(pg_temp.api_value('user A', null, 'select count(*)::text from app.beta_list'), '0',
          'bizcost_api reads nothing of the list directly, whoever it acts for');
select is(pg_temp.api_exec('user A', null, $$insert into app.beta_list (email) values ('me@example.test')$$),
          'ERROR 42501', 'nor adds to it');
select is(pg_temp.api_exec('user A', null, 'delete from app.beta_list'), 'ok 0', 'nor takes off it');
select is(pg_temp.api_exec('user A', null, 'update app.beta_list set removed_at = now()'), 'ok 0',
          'nor changes it');
select ok(not has_function_privilege('anon', 'app.platform_beta_add(text, text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app.platform_beta_add(text, text)', 'EXECUTE')
          and not has_function_privilege('anon', 'app.platform_feedback(uuid, integer)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app.platform_feedback(uuid, integer)', 'EXECUTE'),
          'the Data API roles may call none of the page''s functions');
select is(
  pg_temp.api_value('user A', null, $$
    select email from app.platform_beta_add(' NEW@Example.Test ', 'a note') $$),
  'new@example.test',
  'the page adds an address in lower case, with who added it'
);
select is((select added_by from app.beta_list where email::text = 'new@example.test'),
          pg_temp.id('user A'), 'who added it is kept');
select is(
  pg_temp.api_exec(null, null, $$select * from app.platform_beta_add('x@example.test', null)$$),
  'ERROR 42501',
  'adding needs a caller'
);
select is(
  pg_temp.api_exec('user A', null, $$select * from app.platform_beta_add('not an address', null)$$),
  'ERROR 23514',
  'the table refuses what is not an address'
);
select is(
  pg_temp.api_value('user U', null, 'select app.my_verified_email()'),
  null,
  'an address not yet confirmed is no one''s (a stranger could have signed it up)'
);
select is(
  pg_temp.api_value('user A', null, 'select app.my_verified_email()'),
  'amal.beta@example.test',
  'a confirmed one is its owner''s'
);

-- 4. Feedback -------------------------------------------------------------------------------------------

select is(
  pg_temp.api_exec('user W', null, format($f$
    insert into app.feedback (id, user_id, page_path, message)
    values (pg_temp.id('fb 1'), %L, '/setup', 'Stuck') $f$, pg_temp.id('user W'))),
  'ok 1',
  'anyone signed in adds their own, outside any business'
);
select is(
  (select from_business_id from app.feedback where id = pg_temp.id('fb 1')),
  null,
  'with no business'
);
select is(
  pg_temp.api_exec('user W', null, format($f$
    insert into app.feedback (id, user_id, page_path, message)
    values (pg_temp.id('fb 2'), %L, '/setup', 'As another') $f$, pg_temp.id('user A'))),
  'ERROR 42501',
  'never as someone else'
);
select is(
  pg_temp.api_exec('user W', 'biz A', format($f$
    insert into app.feedback (id, user_id, page_path, message)
    values (pg_temp.id('fb 3'), %L, '/', 'From a business not mine') $f$, pg_temp.id('user W'))),
  'ERROR 42501',
  'never from a business they are not an active member of'
);
select is(
  pg_temp.api_exec('user X', 'biz A', format($f$
    insert into app.feedback (id, user_id, from_business_id, from_member_id, page_path, message)
    values (pg_temp.id('fb 4'), %L, null, null, '/', 'From my business') $f$, pg_temp.id('user X'))),
  'ok 1',
  'a member adds theirs from their business'
);
select is(
  (select from_member_id from app.feedback where id = pg_temp.id('fb 4')),
  pg_temp.id('member X'),
  'the database writes who it came from, whatever the row said'
);
select is(pg_temp.api_value('user X', 'biz A', 'select count(*)::text from app.feedback'), '0',
          'nobody reads feedback directly, not even its sender');
select is(
  pg_temp.api_exec('user X', 'biz A', format($f$
    insert into app.feedback (id, user_id, page_path, message)
    values (pg_temp.id('fb 5'), %L, 'https://evil.example/?a=b', 'x') $f$, pg_temp.id('user X'))),
  'ERROR 23514',
  'the page is a path, by a check of the table'
);
select is(
  pg_temp.api_exec('user X', 'biz A', format($f$
    insert into app.feedback (id, user_id, page_path, message, image_path, image_content_type, image_size_bytes)
    values (pg_temp.id('fb 6'), %1$L, '/', 'x', 'feedback/%1$s/not-mine.png', 'image/png', 1) $f$,
    pg_temp.id('user X'))),
  'ERROR 23514',
  'a picture must be an upload of the sender''s, closed'
);

-- 5. Storage takes a feedback picture only at an open upload of its own ----------------------------------

select is(
  pg_temp.api_exec('user W', null, format($f$
    insert into app.feedback_uploads (id, user_id, path, content_type, expires_at) values
      (pg_temp.id('up 1'), %1$L, 'feedback/%1$s/open.png', 'image/png', now() + interval '1 hour'),
      (pg_temp.id('up 2'), %1$L, 'feedback/%1$s/late.png', 'image/png', now() - interval '1 minute') $f$,
    pg_temp.id('user W'))),
  'ok 2',
  'setup: an open upload and an expired one'
);
select is(pg_temp.storage_put(format('feedback/%s/open.png', pg_temp.id('user W'))), 'ok',
          'Storage takes the open one');
select is(pg_temp.storage_put(format('feedback/%s/late.png', pg_temp.id('user W'))), 'ERROR 42501',
          'not the expired one');
select is(pg_temp.storage_put('feedback/anything.png'), 'ERROR 42501', 'nor a path nobody issued');

-- A send has claimed it (D-362): the object under its check cannot change.
select is(
  pg_temp.api_exec('user W', null, format($f$
    insert into app.feedback_uploads (id, user_id, path, content_type, expires_at, status) values
      (pg_temp.id('up 3'), %1$L, 'feedback/%1$s/held.png', 'image/png', now() + interval '1 hour', 'checking') $f$,
    pg_temp.id('user W'))),
  'ok 1',
  'setup: an upload one send has claimed'
);
select is(pg_temp.storage_put(format('feedback/%s/held.png', pg_temp.id('user W'))), 'ERROR 42501',
          'Storage takes nothing at a path being checked');

-- 6. A sign-up only started goes when what allowed its address goes (D-362) ------------------------------

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, u.confirmed, '{}', '{}', now(), now()
  from (values
    ('started', 'started.beta@example.test', null),
    ('confirmed', 'confirmed.beta@example.test', now()),
    ('invited', 'invited.beta@example.test', null),
    ('twice', 'twice.beta@example.test', null)
  ) as u(name, email, confirmed);

insert into app.beta_list (id, email) values
  (pg_temp.id('list started'), 'started.beta@example.test'),
  (pg_temp.id('list confirmed'), 'confirmed.beta@example.test'),
  (pg_temp.id('list twice'), 'twice.beta@example.test');

select is(
  pg_temp.api_value('user A', null,
    format('select app.platform_beta_remove(%L)', pg_temp.id('list started'))),
  'true',
  'an address on the list is taken off'
);
select is(
  (select count(*)::int from auth.users where id = pg_temp.id('started')),
  0,
  'and the sign-up it only started goes'
);
select is(
  pg_temp.api_value('user A', null,
    format('select app.platform_beta_remove(%L)', pg_temp.id('list confirmed'))),
  'true',
  'a second address is taken off'
);
select is(
  (select count(*)::int from auth.users where id = pg_temp.id('confirmed')),
  1,
  'its confirmed account stays'
);

select is(
  pg_temp.api_exec('user A', 'biz A', format($f$
    insert into app.business_invitations
      (id, business_id, email, role_id, token_hash, expires_at, created_by, locale) values
      (pg_temp.id('inv started'), pg_temp.id('biz A'), 'invited.beta@example.test', pg_temp.id('staff role A'),
       repeat('c', 64), now() + interval '1 day', %1$L, 'en'),
      (pg_temp.id('inv twice'), pg_temp.id('biz A'), 'twice.beta@example.test', pg_temp.id('staff role A'),
       repeat('d', 64), now() + interval '1 day', %1$L, 'en') $f$,
    pg_temp.id('user A'))),
  'ok 2',
  'setup: two invitations'
);
select is(
  pg_temp.api_exec('user A', 'biz A', format(
    $f$update app.business_invitations set status = 'revoked' where id = %L$f$,
    pg_temp.id('inv started'))),
  'ok 1',
  'an invitation is revoked'
);
select is(
  (select count(*)::int from auth.users where id = pg_temp.id('invited')),
  0,
  'and the sign-up it allowed goes'
);
select is(
  pg_temp.api_exec('user A', 'biz A', format(
    $f$update app.business_invitations set status = 'revoked' where id = %L$f$,
    pg_temp.id('inv twice'))),
  'ok 1',
  'another is revoked, for an address still on the list'
);
select is(
  (select count(*)::int from auth.users where id = pg_temp.id('twice')),
  1,
  'its sign-up stays: the list still allows it'
);

select * from finish();
rollback;
