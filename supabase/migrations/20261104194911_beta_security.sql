-- BizCost: the closed beta (D-350, D-355, D-356). Hand-written part of beta_tables: who may create an
-- account (the Auth hook), the owner's beta list, the feedback and its pictures. See docs/DATA_MODEL.md
-- §4 and docs/ARCHITECTURE.md §Auth.
--
-- These are the operator's rows, not a business's, so there is no tenant policy. The rules of
-- tenancy_security otherwise: ENABLE + FORCE RLS, SET search_path = '' with schema-qualified names,
-- owner postgres (BYPASSRLS), EXECUTE revoked from PUBLIC/anon/authenticated and granted only as noted.

----------------------------------------------------------------------------------------------------
-- Row level security
----------------------------------------------------------------------------------------------------

-- No policy: bizcost_api sees and writes nothing here but through the functions below.
alter table app.beta_list enable row level security;
alter table app.beta_list force row level security;

-- A caller adds only their own feedback and never reads any (app.platform_feedback is the only reader).
alter table app.feedback enable row level security;
alter table app.feedback force row level security;
create policy own_feedback_insert on app.feedback
  as permissive for insert to bizcost_api
  with check (user_id = (select app.current_user_id()));

-- A caller's own upload registry, as app.file_uploads is a business's.
alter table app.feedback_uploads enable row level security;
alter table app.feedback_uploads force row level security;
create policy own_feedback_upload_select on app.feedback_uploads
  as permissive for select to bizcost_api
  using (user_id = (select app.current_user_id()));
create policy own_feedback_upload_insert on app.feedback_uploads
  as permissive for insert to bizcost_api
  with check (user_id = (select app.current_user_id()));
create policy own_feedback_upload_update on app.feedback_uploads
  as permissive for update to bizcost_api
  using (user_id = (select app.current_user_id()))
  with check (user_id = (select app.current_user_id()));

----------------------------------------------------------------------------------------------------
-- Who may create an account while sign-up is closed (Q3, D-355)
----------------------------------------------------------------------------------------------------

-- On the beta list, or holding an invitation that could be accepted now: pending, not expired, in a
-- live business, for a live role that is not the owner's, from someone still allowed to invite (as
-- app.accept_invitation checks them). Called only by the hook; no grant.
create function app.signup_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1
      from app.beta_list l
      where pg_catalog.lower(l.email::text) = pg_catalog.lower(pg_catalog.btrim(p_email))
        and l.removed_at is null
    )
    or exists (
      select 1
      from app.business_invitations i
      join app.businesses b on b.id = i.business_id and b.deleted_at is null
      join app.roles invited
        on invited.business_id = i.business_id
        and invited.id = i.role_id
        and invited.deleted_at is null
        and invited.template_key is distinct from 'owner'
      join app.business_members m
        on m.business_id = i.business_id
        and m.user_id = i.created_by
        and m.kind = 'account'
        and m.status = 'active'
        and m.deleted_at is null
      left join app.roles r
        on r.business_id = m.business_id and r.id = m.role_id and r.deleted_at is null
      where pg_catalog.lower(i.email::text) = pg_catalog.lower(pg_catalog.btrim(p_email))
        and i.status = 'pending'
        and i.deleted_at is null
        and i.expires_at > pg_catalog.now()
        and (
          r.template_key = 'owner'
          or (
            (
              exists (
                select 1 from app.role_permissions rp
                where rp.business_id = m.business_id
                  and rp.role_id = m.role_id
                  and rp.permission_key = 'settings.members.manage'
                  and rp.deleted_at is null
              )
              or exists (
                select 1 from app.member_permission_overrides o
                where o.business_id = m.business_id
                  and o.member_id = m.id
                  and o.permission_key = 'settings.members.manage'
                  and o.effect = 'allow'
                  and o.deleted_at is null
              )
            )
            and not exists (
              select 1 from app.member_permission_overrides o
              where o.business_id = m.business_id
                and o.member_id = m.id
                and o.permission_key = 'settings.members.manage'
                and o.effect = 'deny'
                and o.deleted_at is null
            )
          )
        )
    )
$$;

revoke all on function app.signup_allowed(text) from public, anon, authenticated;

comment on function app.signup_allowed(text) is
  'Whether this address may create an account while sign-up is closed: on the beta list, or with an invitation that could be accepted now (D-355).';

-- Supabase Auth's "before user created" hook (auth.hook.before_user_created in config.toml, on only
-- where db-migrate.yml turns it on): every way Auth creates a user passes here, whatever the client:
-- sign-up, "sign in with a code", a direct call to the endpoints. It answers an empty object to go on,
-- or an error whose message the app reads as its code (auth.errors.betaInviteOnly): the same answer
-- for everyone refused, so it says nothing about who is on the list. A failure here is a 500 from
-- Auth: nobody gets in. In a schema of its own, so the Auth role gets nothing on schema app.
create schema auth_hooks;
revoke all on schema auth_hooks from public, anon, authenticated;

create function auth_hooks.before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.btrim(event #>> '{user,email}');
begin
  if v_email is not null and v_email <> '' and app.signup_allowed(v_email) then
    return '{}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object(
    'error', pg_catalog.jsonb_build_object('http_code', 403, 'message', 'beta_invite_only')
  );
end
$$;

revoke all on function auth_hooks.before_user_created(jsonb) from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    raise warning 'role supabase_auth_admin is missing: no grant on auth_hooks';
    return;
  end if;
  execute 'grant usage on schema auth_hooks to supabase_auth_admin';
  execute 'grant execute on function auth_hooks.before_user_created(jsonb) to supabase_auth_admin';
end
$$;

comment on function auth_hooks.before_user_created(jsonb) is
  'Supabase Auth before-user-created hook: closed sign-up (D-355).';

----------------------------------------------------------------------------------------------------
-- The owner's beta page: platform admins only, checked by the API (BIZCOST_PLATFORM_ADMINS, D-357)
----------------------------------------------------------------------------------------------------

-- The caller's address once it is confirmed: who a platform admin is, from Auth's own row (a token's
-- claim is not read for this, as for an invitation).
create function app.my_verified_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
  from auth.users u
  where u.id = app.current_user_id() and u.email_confirmed_at is not null
$$;

revoke all on function app.my_verified_email() from public, anon, authenticated;
grant execute on function app.my_verified_email() to bizcost_api;

create function app.platform_beta_list()
returns table (id uuid, email text, note text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.email::text, l.note, l.created_at
  from app.beta_list l
  where l.removed_at is null
  order by l.created_at desc, l.id
$$;

revoke all on function app.platform_beta_list() from public, anon, authenticated;
grant execute on function app.platform_beta_list() to bizcost_api;

-- Adding an address on the list changes only its note: the same result however often it is sent.
create function app.platform_beta_add(p_email text, p_note text)
returns table (id uuid, email text, note text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := app.current_user_id();
begin
  if v_user is null then
    raise exception 'platform_beta_add requires a signed-in caller' using errcode = 'insufficient_privilege';
  end if;
  return query
    insert into app.beta_list as l (email, note, added_by)
    values (pg_catalog.lower(pg_catalog.btrim(p_email)), p_note, v_user)
    on conflict (pg_catalog.lower(email::text)) where removed_at is null
    do update set note = coalesce(excluded.note, l.note)
    returning l.id, l.email::text, l.note, l.created_at;
end
$$;

revoke all on function app.platform_beta_add(text, text) from public, anon, authenticated;
grant execute on function app.platform_beta_add(text, text) to bizcost_api;

-- Taken off the list, the row stays with who did it. An account already made stays too.
create function app.platform_beta_remove(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := app.current_user_id();
begin
  if v_user is null then
    raise exception 'platform_beta_remove requires a signed-in caller' using errcode = 'insufficient_privilege';
  end if;
  update app.beta_list l
  set removed_at = pg_catalog.now(), removed_by = v_user
  where l.id = p_id and l.removed_at is null;
  return found;
end
$$;

revoke all on function app.platform_beta_remove(uuid) from public, anon, authenticated;
grant execute on function app.platform_beta_remove(uuid) to bizcost_api;

-- The feedback, newest first (ids are UUIDv7). Holds what the sender wrote and who and where they were,
-- nothing else of the business. Names are read now: a deleted account has left none.
create function app.platform_feedback(p_before uuid, p_limit integer)
returns table (
  id uuid,
  message text,
  page_path text,
  image_path text,
  created_at timestamptz,
  business_name text,
  member_name text,
  email text
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.message, f.page_path, f.image_path, f.created_at, b.legal_name,
         coalesce(m.display_name, p.display_name), u.email::text
  from app.feedback f
  left join app.businesses b on b.id = f.from_business_id
  left join app.business_members m
    on m.business_id = f.from_business_id and m.id = f.from_member_id
  left join app.profiles p on p.id = f.user_id
  left join auth.users u on u.id = f.user_id
  where p_before is null or f.id < p_before
  order by f.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
$$;

revoke all on function app.platform_feedback(uuid, integer) from public, anon, authenticated;
grant execute on function app.platform_feedback(uuid, integer) to bizcost_api;

----------------------------------------------------------------------------------------------------
-- Feedback (Q4, D-356)
----------------------------------------------------------------------------------------------------

-- The business and member come from this request's own context, never from the caller; outside a
-- business there are none. In a business the caller must be an active member. At most 10 an hour and
-- 30 a day per person (the advisory lock makes concurrent requests count each other): BZ429. A picture
-- must be the caller's own upload, closed in this transaction (the API checked the object).
create function app.guard_feedback()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := app.current_user_id();
  v_business uuid := app.current_business_id();
  v_member uuid;
begin
  if v_user is null or new.user_id is distinct from v_user then
    raise exception 'feedback is sent only as oneself' using errcode = 'insufficient_privilege';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.guard_feedback:' || v_user::text, 0)
  );
  if (
    select pg_catalog.count(*) from app.feedback f
    where f.user_id = v_user and f.created_at > pg_catalog.now() - interval '1 hour'
  ) >= 10 or (
    select pg_catalog.count(*) from app.feedback f
    where f.user_id = v_user and f.created_at > pg_catalog.now() - interval '1 day'
  ) >= 30 then
    raise exception 'feedback_limit: at most 10 an hour and 30 a day' using errcode = 'BZ429';
  end if;
  new.created_at := pg_catalog.now();
  if v_business is null then
    new.from_business_id := null;
    new.from_member_id := null;
  else
    select m.id into v_member
    from app.business_members m
    where m.business_id = v_business
      and m.user_id = v_user
      and m.kind = 'account'
      and m.status = 'active'
      and m.deleted_at is null;
    if v_member is null then
      raise exception 'feedback from a business needs its active member' using errcode = 'insufficient_privilege';
    end if;
    new.from_business_id := v_business;
    new.from_member_id := v_member;
  end if;
  if new.image_path is not null and not exists (
    select 1 from app.feedback_uploads u
    where u.path = new.image_path and u.user_id = v_user and u.status = 'used'
  ) then
    raise exception 'a feedback picture is the sender''s own checked upload' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger guard_feedback before insert on app.feedback
  for each row execute function app.guard_feedback();

-- At most 10 upload URLs an hour per person, used or not: BZ429.
create function app.feedback_upload_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.feedback_upload_limits:' || new.user_id::text, 0)
  );
  if (
    select pg_catalog.count(*) from app.feedback_uploads u
    where u.user_id = new.user_id and u.created_at > pg_catalog.now() - interval '1 hour'
  ) >= 10 then
    raise exception 'feedback_upload_limit: at most 10 an hour' using errcode = 'BZ429';
  end if;
  new.created_at := pg_catalog.now();
  return new;
end
$$;

create trigger feedback_upload_limits before insert on app.feedback_uploads
  for each row execute function app.feedback_upload_limits();

-- As settings_hardening, with feedback pictures beside a business's files: Storage writes an object of
-- business-files only at a path the API issued, still open and not expired. A feedback picture's folder
-- is its sender's, since a person may have no business yet.
create or replace function app.guard_business_file()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and new.name is not distinct from old.name
    and new.bucket_id is not distinct from old.bucket_id
    and new.version is not distinct from old.version
  then
    -- Metadata only (e.g. last access): the file itself does not change.
    return new;
  end if;

  if new.name is not null and pg_catalog.starts_with(new.name, 'feedback/') then
    if not exists (
      select 1
      from app.feedback_uploads u
      where u.path = new.name
        and u.status = 'issued'
        and u.expires_at > pg_catalog.now()
    ) then
      raise exception 'business_file_not_issued: no open upload for this path'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.name is null
    or new.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    or not exists (
      select 1
      from app.file_uploads u
      where u.business_id = pg_catalog.split_part(new.name, '/', 1)::uuid
        and u.path = new.name
        and u.status = 'issued'
        and u.deleted_at is null
        and u.expires_at > pg_catalog.now()
    )
  then
    raise exception 'business_file_not_issued: no open upload for this path'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
