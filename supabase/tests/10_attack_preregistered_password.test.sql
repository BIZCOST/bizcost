-- pgTAP (attack, regression): a password chosen before an address was confirmed does not survive
-- its confirmation (D-102), the pre-registered account takeover.
-- Anyone can sign up with someone else's address and a password of their own; when the owner of the
-- address confirms it with an emailed code (the sign-up code, "Send me a code", a resent code or a
-- reset code), app.forget_unconfirmed_password (BEFORE UPDATE OF email_confirmed_at ON auth.users)
-- sets encrypted_password to '' (Supabase Auth's "no password"). The statements below are the ones
-- Supabase Auth runs (UpdateOnly of the listed columns); tests against the real Auth server are in
-- packages/api/test/attack.preaccount.api.test.ts.
begin;
select plan(14);

create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5(p_name)::uuid $$;

-- A bcrypt-shaped value: the trigger never reads it.
create function pg_temp.hash(p_label text) returns text
language sql immutable
as $$ select '$2a$10$' || rpad(p_label, 53, 'x') $$;

create function pg_temp.password_of(p_name text) returns text
language sql stable
as $$ select encrypted_password from auth.users where id = pg_temp.id(p_name) $$;

-- Fixtures: unconfirmed users as the sign-up endpoint leaves them (a code was emailed), and one as
-- the admin API inserts it before confirming it in the same transaction (nothing was emailed).
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        confirmation_token, confirmation_sent_at, recovery_token, recovery_sent_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, u.password, u.confirmed_at,
       -- a token is unique in auth.users unless it is '' (Supabase Auth's "none")
       case u.confirmation_token when '' then '' else u.confirmation_token || '-' || u.name end,
       u.confirmation_sent_at,
       case u.recovery_token when '' then '' else u.recovery_token || '-' || u.name end,
       u.recovery_sent_at, '{}', '{}', now(), now()
  from (values
    -- signed up by a stranger; the owner enters the sign-up code
    ('signup',   'signup@example.test',   pg_temp.hash('stranger'), null::timestamptz, 'tok', now() - interval '2 minutes', '', null::timestamptz),
    -- signed up by a stranger; the owner enters a reset code
    ('recovery', 'recovery@example.test', pg_temp.hash('stranger'), null, 'tok', now() - interval '9 days', 'rtok', now()),
    -- only a reset code was ever sent (an admin-made unconfirmed user)
    ('reset',    'reset@example.test',    pg_temp.hash('admin'),    null, '', null, 'rtok', now()),
    -- the admin API: inserted, then confirmed; nothing was emailed
    ('admin',    'admin@example.test',    pg_temp.hash('admin'),    null, '', null, '', null),
    -- a password set in the same statement that confirms the address
    ('both',     'both@example.test',     pg_temp.hash('stranger'), null, 'tok', now(), '', null),
    -- already confirmed: a later change of email_confirmed_at is not a confirmation
    ('confirmed','confirmed@example.test',pg_temp.hash('owner'),    now() - interval '1 day', '', now() - interval '2 days', '', null),
    -- created by "Send me a code" without a password of its own ('' is no password)
    ('nopass',   'nopass@example.test',   '',                       null, 'tok', now(), '', null),
    -- unconfirmed, other columns change (a resend, a sign-in attempt)
    ('pending',  'pending@example.test',  pg_temp.hash('stranger'), null, 'tok', now(), '', null)
  ) as u(name, email, password, confirmed_at, confirmation_token, confirmation_sent_at,
         recovery_token, recovery_sent_at);

-- 1. The trigger (3) -----------------------------------------------------------------------------

select trigger_is(
  'auth', 'users', 'forget_unconfirmed_password',
  'app', 'forget_unconfirmed_password',
  'auth.users has the trigger forget_unconfirmed_password calling app.forget_unconfirmed_password()'
);

-- pg_trigger.tgtype bits: 1 ROW, 2 BEFORE, 16 UPDATE; tgattr lists the UPDATE OF columns.
select ok(
  (select t.tgtype & (1 | 2 | 4 | 8 | 16) = (1 | 2 | 16)
          and t.tgenabled = 'O'
          and (select array_agg(a.attname::text)
                 from pg_attribute a
                where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)) = array['email_confirmed_at']
     from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass and t.tgname = 'forget_unconfirmed_password'),
  'it runs BEFORE UPDATE OF email_confirmed_at, FOR EACH ROW, and is enabled'
);

select ok(
  coalesce(
    (select not p.prosecdef
            and 'search_path=""' = any(coalesce(p.proconfig, '{}'::text[]))
            and pg_get_userbyid(p.proowner) = 'postgres'
            and not has_function_privilege('anon', p.oid, 'EXECUTE')
            and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       from pg_proc p
      where p.oid = to_regprocedure('app.forget_unconfirmed_password()')),
    false),
  'the function is SECURITY INVOKER, pins search_path, is owned by postgres, and anon/authenticated cannot execute it'
);

-- 2. Confirmations by an emailed code drop the password (4) ------------------------------------

-- verifyOtp with the sign-up code (also "Send me a code" and a resent code on an unconfirmed account)
update auth.users set confirmation_token = '', email_confirmed_at = now()
 where id = pg_temp.id('signup');
select is(pg_temp.password_of('signup'), '', 'the sign-up code confirms the address: the password set before is gone');

-- verifyOtp with a reset code: Recover, then Confirm
update auth.users set recovery_token = '' where id = pg_temp.id('recovery');
select is(pg_temp.password_of('recovery'), pg_temp.hash('stranger'), 'using the reset code alone changes nothing yet');
update auth.users set confirmation_token = '', email_confirmed_at = now()
 where id = pg_temp.id('recovery');
select is(pg_temp.password_of('recovery'), '', 'the reset code confirms the address: the password set before is gone');

update auth.users set confirmation_token = '', email_confirmed_at = now()
 where id = pg_temp.id('reset');
select is(pg_temp.password_of('reset'), '', 'a reset code is an emailed code too, whoever set the password');

-- 3. What stays (6) -------------------------------------------------------------------------------

update auth.users set confirmation_token = '', email_confirmed_at = now()
 where id = pg_temp.id('admin');
select is(pg_temp.password_of('admin'), pg_temp.hash('admin'),
  'confirmed without any emailed code (the admin API''s email_confirm): the password stays');

update auth.users
   set encrypted_password = pg_temp.hash('owner'), confirmation_token = '', email_confirmed_at = now()
 where id = pg_temp.id('both');
select is(pg_temp.password_of('both'), pg_temp.hash('owner'),
  'a password set by the statement that confirms the address stays');

update auth.users set email_confirmed_at = now() where id = pg_temp.id('confirmed');
select is(pg_temp.password_of('confirmed'), pg_temp.hash('owner'),
  'an address that was already confirmed keeps its password');

update auth.users set confirmation_token = '', email_confirmed_at = now()
 where id = pg_temp.id('nopass');
select is(pg_temp.password_of('nopass'), '', 'no password stays no password');

update auth.users
   set confirmation_token = 'tok2-pending', confirmation_sent_at = now(), last_sign_in_at = now(),
       raw_user_meta_data = '{"locale": "ar"}'
 where id = pg_temp.id('pending');
select is(pg_temp.password_of('pending'), pg_temp.hash('stranger'),
  'changes that do not confirm the address leave the password alone');

update auth.users set email_confirmed_at = null where id = pg_temp.id('pending');
select is(pg_temp.password_of('pending'), pg_temp.hash('stranger'),
  'setting email_confirmed_at to null is not a confirmation');

-- 4. The owner sets a password after the code (1) ----------------------------------------------

update auth.users set encrypted_password = pg_temp.hash('owner'), confirmation_sent_at = null
 where id = pg_temp.id('signup');
select is(pg_temp.password_of('signup'), pg_temp.hash('owner'),
  'the password the owner sets after the code (updateUser) is kept');

select * from finish();
rollback;
