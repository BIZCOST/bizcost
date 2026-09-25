-- pgTAP: web settings (Milestone 1, Step 6): the business-files bucket, members' emails, the invitation
-- limits (app.invitation_limits), app.preview_invitation and the new app.accept_invitation rules.
-- Statements under test run as bizcost_api with tenant context, like the API does.
begin;
select plan(37);

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
-- 'ok <row count>', the first column of the first row (p_scalar), or 'ERROR <sqlstate>: <message>'.
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
    v_out := 'ERROR ' || sqlstate || ': ' || sqlerrm;
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

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, u.confirmed_at, '{}', '{}', now(), now()
  from (values
    ('user A', 'amal@example.test',   now()),  -- owner
    ('user I', 'ivy@example.test',    now()),  -- invitee
    ('user W', 'walt@example.test',   now()),  -- someone else
    ('user U', 'una@example.test',    null),   -- email not verified
    ('user M', 'maya@example.test',   now())   -- already a member
  ) as u(name, email, confirmed_at);

-- 1. Storage bucket (5) --------------------------------------------------------------------

select is(
  (select public from storage.buckets where id = 'business-files'),
  false,
  'the business-files bucket exists and is private'
);

select is(
  (select file_size_limit from storage.buckets where id = 'business-files'),
  2097152::bigint,
  'business-files takes files up to 2 MB'
);

select is(
  (select allowed_mime_types from storage.buckets where id = 'business-files'),
  array['image/png', 'image/jpeg', 'image/webp'],
  'business-files takes only PNG, JPEG and WebP (no SVG)'
);

select is_empty(
  $$ select policyname from pg_policies
      where schemaname = 'storage'
        and strpos(coalesce(qual, '') || coalesce(with_check, ''), 'business-files') > 0 $$,
  'no Storage policy opens business-files: clients use only signed URLs issued by the API'
);

select ok(
  not has_table_privilege('bizcost_api', 'storage.objects', 'SELECT, INSERT, UPDATE, DELETE'),
  'bizcost_api cannot touch storage.objects'
);

-- 2. Functions (6) -------------------------------------------------------------------------------

select is_definer('app', 'preview_invitation', array['text']::name[],
                  'app.preview_invitation(text) is SECURITY DEFINER');
select is_definer('app', 'invitation_limits', '{}'::name[],
                  'app.invitation_limits() is SECURITY DEFINER');
select ok(
  has_function_privilege('bizcost_api', 'app.preview_invitation(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.preview_invitation(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.preview_invitation(text)', 'EXECUTE'),
  'only bizcost_api may run app.preview_invitation'
);
select col_type_is('app', 'business_members', 'email', 'extensions', 'citext',
                   'business_members.email is citext');
select col_is_null('app', 'business_members', 'email', 'business_members.email is optional (pin_only staff)');
select has_trigger('app', 'business_invitations', 'invitation_limits',
                   'business_invitations runs app.invitation_limits');

-- 3. Fixtures: business A made by app.create_business (it keeps the owner's email) ---------------

select is(
  pg_temp.api_value('user A', null, $$
    select app.create_business(pg_temp.id('biz A'), 'Amal Bakery', 'en', 'Amal',
                               pg_temp.id('owner role A'), pg_temp.id('member A')) $$),
  pg_temp.id('biz A')::text,
  'setup: user A creates business A'
);

select is(
  (select email::text from app.business_members where id = pg_temp.id('member A')),
  'amal@example.test',
  'app.create_business stores the owner''s email on the membership'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.roles (id, business_id, name, template_key)
    values (pg_temp.id('staff role A'), pg_temp.id('biz A'), 'Employee', 'employee');
    insert into app.business_members (id, business_id, user_id, kind, display_name, email, status, role_id)
    values (pg_temp.id('member M'), pg_temp.id('biz A'), pg_temp.id('user M'), 'account', 'Maya',
            'maya@example.test', 'active', pg_temp.id('staff role A')) $$),
  'ok 1',
  'setup: an Employee role and Maya, an active member'
);

-- Tokens are 'token <who>'; only their sha256 hex is stored.
select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, status,
                                          role_id, locale, send_count, last_sent_at)
    select pg_temp.id('invitation ' || v.who), pg_temp.id('biz A'), v.email,
           encode(sha256(convert_to('token ' || v.who, 'UTF8')), 'hex'), now() + v.ttl, v.status,
           v.role, 'en', 1, now()
      from (values
        ('ivy',   'Ivy@Example.test',   interval '7 days', 'pending', pg_temp.id('staff role A')),
        ('una',   'una@example.test',   interval '7 days', 'pending', pg_temp.id('staff role A')),
        ('old',   'old@example.test',   interval '-1 day', 'pending', pg_temp.id('staff role A')),
        ('gone',  'gone@example.test',  interval '7 days', 'revoked', pg_temp.id('staff role A')),
        ('maya',  'maya@example.test',  interval '7 days', 'pending', pg_temp.id('staff role A')),
        ('boss',  'walt@example.test',  interval '7 days', 'pending', pg_temp.id('owner role A'))
      ) as v(who, email, ttl, status, role) $$),
  'ok 6',
  'setup: business A sends six invitations'
);

-- 4. app.preview_invitation (9) ------------------------------------------------------------------

select is(
  pg_temp.api_value(null, null, $$
    select format('%s|%s|%s|%s|%s|%s', business_name, inviter_name, role_template_key, masked_email,
                  expired::text, coalesce(email_matches::text, 'null'))
      from app.preview_invitation('token ivy') $$),
  'Amal Bakery|Amal|employee|I•••@Example.test|false|null',
  'a signed-out caller sees the business, the inviter, the role and a masked email only'
);

select is(
  pg_temp.api_value('user I', null, $$select email_matches::text from app.preview_invitation('token ivy')$$),
  'true',
  'a signed-in invitee is told the invitation is for their verified email'
);

select is(
  pg_temp.api_value('user W', null, $$select email_matches::text from app.preview_invitation('token ivy')$$),
  'false',
  'another signed-in user is told it is not theirs'
);

select is(
  pg_temp.api_value('user U', null, $$select email_matches::text from app.preview_invitation('token una')$$),
  'false',
  'an unverified email does not count as a match'
);

select is(
  pg_temp.api_value(null, null, $$select expired::text from app.preview_invitation('token old')$$),
  'true',
  'an expired pending invitation is shown as expired'
);

create temp table preview_invalid as
  select pg_temp.api_value(null, null, $$select masked_email from app.preview_invitation('no-such-token')$$) as msg;

select matches((select msg from preview_invalid), '^ERROR BZ404', 'an unknown token raises BZ404 invitation_invalid');

select is(
  pg_temp.api_value(null, null, $$select masked_email from app.preview_invitation('token gone')$$),
  (select msg from preview_invalid),
  'a revoked invitation gets the same answer as an unknown token'
);

select is(
  (select preview_count from app.business_invitations where id = pg_temp.id('invitation ivy')),
  3,
  'each preview is counted on the invitation'
);

select is(
  (select string_agg(r, ',') from (
     select pg_temp.api_value(null, null, $$select masked_email from app.preview_invitation('token ivy')$$) as r
       from generate_series(1, 28)) as s
    where r like 'ERROR%'),
  'ERROR BZ429: invitation_preview_limit: at most 30 previews per invitation in an hour',
  'the 31st preview of one invitation within an hour is refused (BZ429)'
);

-- 5. app.accept_invitation (8) -------------------------------------------------------------------

create temp table accept_invalid as
  select pg_temp.api_value('user W', null, $$select app.accept_invitation('no-such-token', pg_temp.id('member W'))$$) as msg;

select matches((select msg from accept_invalid), '^ERROR BZ404', 'an unknown token raises BZ404 invitation_invalid');

select is(
  pg_temp.api_value('user U', null, $$select app.accept_invitation('token una', pg_temp.id('member U'))$$),
  (select msg from accept_invalid),
  'an unverified email cannot accept (same answer)'
);

select is(
  pg_temp.api_value('user W', null, $$select app.accept_invitation('token boss', pg_temp.id('member W'))$$),
  (select msg from accept_invalid),
  'an invitation with the Owner role cannot be accepted (ownership is only transferred)'
);

select matches(
  pg_temp.api_value('user M', null, $$select app.accept_invitation('token maya', pg_temp.id('member M2'))$$),
  '^ERROR BZ409: already_member',
  'an active member gets BZ409 already_member'
);

select is(
  pg_temp.api_value('user I', null, $$select app.accept_invitation('token ivy', pg_temp.id('member I'))$$),
  pg_temp.id('biz A')::text,
  'the invitee accepts'
);

select is(
  (select email::text from app.business_members where id = pg_temp.id('member I')),
  'ivy@example.test',
  'the membership keeps the verified email of the account'
);

-- A second business, soft-deleted after inviting: its links stop working.
select is(
  pg_temp.api_value('user W', null, $$
    select app.create_business(pg_temp.id('biz W'), 'Walt Works', 'en', 'Walt',
                               pg_temp.id('owner role W'), pg_temp.id('member W owner')) $$),
  pg_temp.id('biz W')::text,
  'setup: user W creates business W'
);

select is(
  pg_temp.api_exec('user W', 'biz W', $$
    insert into app.roles (id, business_id, name, template_key)
    values (pg_temp.id('staff role W'), pg_temp.id('biz W'), 'Employee', 'employee');
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id, send_count)
    values (pg_temp.id('invitation walt'), pg_temp.id('biz W'), 'ivy@example.test',
            encode(sha256(convert_to('token walt', 'UTF8')), 'hex'), now() + interval '7 days',
            pg_temp.id('staff role W'), 1);
    update app.businesses set deleted_at = now() where id = pg_temp.id('biz W') $$),
  'ok 1',
  'setup: business W invites Ivy, then is deleted'
);

select is(
  pg_temp.api_value('user I', null, $$select app.accept_invitation('token walt', pg_temp.id('member I in W'))$$),
  (select msg from accept_invalid),
  'an invitation of a deleted business cannot be accepted (same answer)'
);

-- 6. app.invitation_limits (4) --------------------------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_invitations set send_count = send_count + 3 where id = pg_temp.id('invitation una') $$),
  'ok 1',
  'three resends are allowed (send_count 4)'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_invitations set send_count = send_count + 1 where id = pg_temp.id('invitation una') $$),
  '^ERROR BZ429',
  'a fourth resend is refused (BZ429)'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_invitations set send_count = 1 where id = pg_temp.id('invitation una') $$),
  '^ERROR 23514',
  'send_count never goes down (the limit cannot be reset)'
);

-- Business A has made 6 invitations today; 14 more reach the limit of 20.
select is(
  (select string_agg(r, ',') from (
     select pg_temp.api_exec('user A', 'biz A', format($f$
       insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id, send_count)
       values (pg_temp.id('bulk %1$s'), pg_temp.id('biz A'), 'bulk%1$s@example.test',
               encode(sha256(convert_to('bulk %1$s', 'UTF8')), 'hex'), now() + interval '7 days',
               pg_temp.id('staff role A'), 1) $f$, n)) as r
       from generate_series(1, 15) as n) as s
    where r <> 'ok 1'),
  'ERROR BZ429: invitation_limit: at most 20 invitations per business in 24 hours',
  'the 21st invitation of a business in 24 hours is refused (BZ429)'
);

select * from finish();
rollback;
