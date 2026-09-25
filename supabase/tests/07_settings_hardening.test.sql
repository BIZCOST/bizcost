-- pgTAP: web settings hardening (Milestone 1, Step 6 review): the upload registry (app.file_uploads,
-- its hourly limit and the Storage guard on business-files), the invitation limits per address and per
-- inviting user, previews that are neither touched nor audited, the inviter check of
-- app.accept_invitation, and app.anonymize_my_memberships. Statements under test run as bizcost_api
-- with tenant context, like the API does; Storage writes run as the test's own role, like Storage.
begin;
select plan(36);

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

-- Writes a Storage object row the way Storage does (as the test's role, not bizcost_api).
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
       u.email, now(), '{}', '{}', now(), now()
  from (values
    ('user A', 'amal@example.test'),   -- owner of A, A2, A3
    ('user X', 'xena@example.test'),   -- an inviter in A
    ('user I', 'ivy@example.test'),    -- invitee
    ('user W', 'walt@example.test')    -- outsider
  ) as u(name, email);

-- Fixtures: business A with an Admin-like role that may invite, an Employee role, and inviter X.
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
      (pg_temp.id('rp 1'), pg_temp.id('biz A'), pg_temp.id('admin role A'), 'settings.members.view'),
      (pg_temp.id('rp 2'), pg_temp.id('biz A'), pg_temp.id('admin role A'), 'settings.members.manage');
    insert into app.business_members (id, business_id, user_id, kind, display_name, email, status, role_id)
    values (pg_temp.id('member X'), pg_temp.id('biz A'), pg_temp.id('user X'), 'account', 'Xena',
            'xena@example.test', 'active', pg_temp.id('admin role A')) $$),
  'ok 1',
  'setup: roles and Xena, who may invite'
);

-- 1. Upload registry and the Storage guard (12) -----------------------------------------------------

select is_definer('app', 'guard_business_file', '{}'::name[],
                  'app.guard_business_file() is SECURITY DEFINER (it reads app.file_uploads for Storage)');
select has_trigger('storage', 'objects', 'guard_business_file',
                   'storage.objects runs app.guard_business_file for business-files');

select is(
  pg_temp.api_exec('user A', 'biz A', format($f$
    insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at, status) values
      (pg_temp.id('upload open'), pg_temp.id('biz A'), '%1$s/logo/open.png', 'logo', 'image/png', now() + interval '2 hours', 'issued'),
      (pg_temp.id('upload used'), pg_temp.id('biz A'), '%1$s/logo/used.png', 'logo', 'image/png', now() + interval '2 hours', 'used'),
      (pg_temp.id('upload gone'), pg_temp.id('biz A'), '%1$s/logo/gone.png', 'logo', 'image/png', now() + interval '2 hours', 'discarded'),
      (pg_temp.id('upload late'), pg_temp.id('biz A'), '%1$s/logo/late.png', 'logo', 'image/png', now() - interval '1 minute', 'issued') $f$,
    pg_temp.id('biz A'))),
  'ok 4',
  'the API registers uploads of its business'
);

select matches(
  pg_temp.api_exec('user A', 'biz A', format($f$
    insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
    values (pg_temp.id('upload elsewhere'), pg_temp.id('biz A'), '%s/logo/x.png', 'logo', 'image/png', now()) $f$,
    pg_temp.id('biz W'))),
  '^ERROR 23514',
  'an upload path must start with its own business id'
);

select is(pg_temp.storage_put(pg_temp.id('biz A') || '/logo/open.png'), 'ok',
          'Storage takes a file at an open, unexpired upload path');
select is(pg_temp.storage_put(pg_temp.id('biz A') || '/logo/used.png'), 'ERROR 42501',
          'a saved upload''s path takes no new file (an old upload URL cannot write again)');
select is(pg_temp.storage_put(pg_temp.id('biz A') || '/logo/gone.png'), 'ERROR 42501',
          'a refused or removed upload''s path takes no new file');
select is(pg_temp.storage_put(pg_temp.id('biz A') || '/logo/late.png'), 'ERROR 42501',
          'an expired upload''s path takes no new file');
select is(pg_temp.storage_put(pg_temp.id('biz A') || '/logo/never.png'), 'ERROR 42501',
          'a path the API never issued takes no file');
select is(pg_temp.storage_put('not-a-business/logo/x.png'), 'ERROR 42501',
          'a path outside any business takes no file');

select is(
  pg_temp.api_value('user W', 'biz A', $$select count(*)::text from app.file_uploads$$),
  '0',
  'another user sees none of a business''s uploads'
);

-- Business A has 4 uploads so far: 6 more reach the limit of 10 an hour.
select is(
  (select string_agg(r, ',') from (
     select pg_temp.api_exec('user A', 'biz A', format($f$
       insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
       values (pg_temp.id('upload %1$s'), pg_temp.id('biz A'), '%2$s/logo/%1$s.png', 'logo',
               'image/png', now() + interval '2 hours') $f$, n, pg_temp.id('biz A'))) as r
       from generate_series(1, 7) as n) as s
    where r <> 'ok 1'),
  'ERROR BZ429: file_upload_limit: at most 10 uploads per business in an hour',
  'the 11th upload of a business in an hour is refused (BZ429)'
);

-- 2. Invitation limits per address and per inviting user (6) ---------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id,
                                          send_count, last_sent_at)
    values (pg_temp.id('invitation vic'), pg_temp.id('biz A'), 'vic@example.test',
            encode(sha256(convert_to('token vic', 'UTF8')), 'hex'), now() + interval '7 days',
            pg_temp.id('staff role A'), 1, now());
    update app.business_invitations set send_count = 4, status = 'revoked'
     where id = pg_temp.id('invitation vic') $$),
  'ok 1',
  'setup: an address got four emails from business A, then the invitation was cancelled'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id,
                                          send_count, last_sent_at)
    values (pg_temp.id('invitation vic 2'), pg_temp.id('biz A'), 'VIC@example.test',
            encode(sha256(convert_to('token vic 2', 'UTF8')), 'hex'), now() + interval '7 days',
            pg_temp.id('staff role A'), 1, now()) $$),
  'ERROR BZ429: invitation_address_limit: at most 4 invitation emails per address in 24 hours',
  'inviting the same address again the same day is refused (cancelling does not start over)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id,
                                          send_count, last_sent_at)
    values (pg_temp.id('invitation ivy'), pg_temp.id('biz A'), 'ivy@example.test',
            encode(sha256(convert_to('token ivy', 'UTF8')), 'hex'), now() + interval '7 days',
            pg_temp.id('staff role A'), 1, now()) $$),
  'ok 1',
  'another address is still fine'
);

-- User A (2 invitations so far) creates two more businesses and sends 19 invitations in each.
select is(
  (select string_agg(r, ',' order by b) from (
     select b, pg_temp.api_value('user A', null, format($f$
       select app.create_business(pg_temp.id('biz A%1$s'), 'Amal %1$s', 'en', 'Amal',
                                  pg_temp.id('owner role A%1$s'), pg_temp.id('member A%1$s'))::text $f$, b)) as r
       from generate_series(2, 3) as b) as s),
  pg_temp.id('biz A2')::text || ',' || pg_temp.id('biz A3')::text,
  'setup: user A creates businesses A2 and A3'
);

select is(
  (select string_agg(r, ',') from (
     select pg_temp.api_exec('user A', 'biz A' || b, format($f$
       insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id,
                                             send_count, last_sent_at)
       values (pg_temp.id('bulk %1$s %2$s'), pg_temp.id('biz A%1$s'), 'bulk%2$s@example.test',
               encode(sha256(convert_to('bulk %1$s %2$s', 'UTF8')), 'hex'), now() + interval '7 days',
               pg_temp.id('owner role A%1$s'), 1, now()) $f$, b, n)) as r
       from generate_series(2, 3) as b, generate_series(1, 19) as n) as s
    where r <> 'ok 1'),
  null,
  'up to 40 invitations a day per user, in all their businesses'
);

select is(
  pg_temp.api_exec('user A', 'biz A3', $$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id,
                                          send_count, last_sent_at)
    values (pg_temp.id('bulk 41'), pg_temp.id('biz A3'), 'bulk41@example.test',
            encode(sha256(convert_to('bulk 41', 'UTF8')), 'hex'), now() + interval '7 days',
            pg_temp.id('owner role A3'), 1, now()) $$),
  'ERROR BZ429: invitation_user_limit: at most 40 invitations per user in 24 hours',
  'the 41st invitation of one user in 24 hours is refused (BZ429), whatever the business'
);

-- 3. Previews are neither touched nor audited (3) --------------------------------------------------

create temp table before_preview as
  select version, updated_at,
         (select count(*) from app.audit_log l where l.entity_id = i.id) as audits
    from app.business_invitations i where i.id = pg_temp.id('invitation ivy');

select is(
  pg_temp.api_value(null, null, $$select masked_email from app.preview_invitation('token ivy')$$),
  'i•••@example.test',
  'setup: a signed-out visitor previews the invitation'
);

select is(
  (select format('%s|%s', i.version, (select count(*) from app.audit_log l where l.entity_id = i.id))
     from app.business_invitations i where i.id = pg_temp.id('invitation ivy')),
  (select format('%s|%s', version, audits) from before_preview),
  'a preview changes neither the invitation''s version nor the audit log'
);

-- (Its own statement: the check below then sees the audit row in a new snapshot.)
create temp table locale_change as
  select pg_temp.api_exec('user A', 'biz A', $$
    update app.business_invitations set locale = 'en' where id = pg_temp.id('invitation ivy') $$) as result;

select is(
  (select result from locale_change)
  || '|' || (select count(*) from app.audit_log l where l.entity_id = pg_temp.id('invitation ivy'))::text,
  'ok 1|' || ((select audits from before_preview) + 1)::text,
  'any other change is still audited'
);

-- 4. The inviter must still be allowed to invite (7) -------------------------------------------

select is(
  pg_temp.api_exec('user X', 'biz A', $$
    insert into app.business_invitations (id, business_id, email, token_hash, expires_at, role_id,
                                          send_count, last_sent_at)
    select pg_temp.id('invitation by x ' || v.n), pg_temp.id('biz A'), 'ivy' || v.n || '@example.test',
           encode(sha256(convert_to('token by x ' || v.n, 'UTF8')), 'hex'), now() + interval '7 days',
           pg_temp.id('staff role A'), 1, now()
      from generate_series(1, 2) as v(n) $$),
  'ok 2',
  'setup: Xena sends two invitations'
);

update auth.users set email = 'ivy1@example.test' where id = pg_temp.id('user I');

create temp table accept_invalid as
  select pg_temp.api_value('user W', null, $$select app.accept_invitation('no-such-token', pg_temp.id('member W'))$$) as msg;

-- Xena may no longer invite: a deny override on settings.members.manage.
select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.member_permission_overrides (id, business_id, member_id, permission_key, effect)
    values (pg_temp.id('deny x'), pg_temp.id('biz A'), pg_temp.id('member X'), 'settings.members.manage', 'deny') $$),
  'ok 1',
  'setup: Xena is denied managing the team'
);

select is(
  pg_temp.api_value('user I', null, $$select app.accept_invitation('token by x 1', pg_temp.id('member I'))$$),
  (select msg from accept_invalid),
  'an invitation from someone who may no longer invite cannot be accepted (same answer)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.member_permission_overrides set deleted_at = now() where id = pg_temp.id('deny x');
    update app.business_members set status = 'removed' where id = pg_temp.id('member X') $$),
  'ok 1',
  'setup: the deny is lifted, and Xena is removed'
);

select is(
  pg_temp.api_value('user I', null, $$select app.accept_invitation('token by x 1', pg_temp.id('member I'))$$),
  (select msg from accept_invalid),
  'an invitation from a removed member cannot be accepted (same answer)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set status = 'active' where id = pg_temp.id('member X') $$),
  'ok 1',
  'setup: Xena is back'
);

select is(
  pg_temp.api_value('user I', null, $$select app.accept_invitation('token by x 1', pg_temp.id('member I'))$$),
  pg_temp.id('biz A')::text,
  'an invitation from an active member who may invite is accepted'
);

-- 5. app.anonymize_my_memberships (6) ------------------------------------------------------------

select is_definer('app', 'anonymize_my_memberships', array['text']::name[],
                  'app.anonymize_my_memberships(text) is SECURITY DEFINER');

select matches(
  pg_temp.api_value('user X', null, $$select app.anonymize_my_memberships('Deleted user')::text$$),
  '^ERROR 42501',
  'only a deleted (anonymized) account may clear its memberships'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.business_members set status = 'removed' where id = pg_temp.id('member X') $$),
  'ok 1',
  'setup: Xena was removed earlier (RLS no longer lets her write that membership)'
);

select is(
  pg_temp.api_exec('user X', null, $$
    insert into app.profiles (id, display_name, locale, anonymized_at)
    values (pg_temp.id('user X'), 'Deleted user', 'en', now()) $$),
  'ok 1',
  'setup: Xena deletes her account (the profile is anonymized)'
);

select is(
  pg_temp.api_value('user X', null, $$select app.anonymize_my_memberships('Deleted user')::text$$),
  '1',
  'then every membership of the account is cleared'
);

select is(
  (select format('%s|%s', coalesce(email::text, 'null'), display_name)
     from app.business_members where id = pg_temp.id('member X')),
  'null|Deleted user',
  'the removed membership lost its email and name'
);

select * from finish();
rollback;
