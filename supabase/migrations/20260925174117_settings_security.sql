-- BizCost: web settings (M1 Step 6). Hand-written part: the private Storage bucket for business
-- files, members' emails, the invitation limits and the invitation preview, and new versions of
-- app.create_business and app.accept_invitation. See docs/DATA_MODEL.md §4 and docs/ARCHITECTURE.md
-- §Auth (invitations), §Storage.
--
-- Rules as in tenancy_security: SET search_path = '' with schema-qualified names, owner postgres,
-- EXECUTE revoked from PUBLIC/anon/authenticated and granted to bizcost_api only. CREATE OR REPLACE
-- keeps the owner and the grants of an existing function.

----------------------------------------------------------------------------------------------------
-- Storage: one private bucket, paths {business_id}/{entity}/{uuidv7}.{ext}
----------------------------------------------------------------------------------------------------

-- Only images for the logo (no SVG: it can carry scripts), at most 2 MB. Uploads and downloads use
-- signed URLs that the API issues after its permission checks; no Storage policy grants anything to
-- anon or authenticated. The size and type columns come from Storage's own migrations; the API checks
-- both again (and the file's first bytes) before it saves a path.
do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is null then
    raise warning 'schema storage is missing: bucket business-files was not created';
    return;
  end if;
  insert into storage.buckets (id, name, public)
  values ('business-files', 'business-files', false)
  on conflict (id) do update set public = false;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types'
  ) then
    update storage.buckets
    set file_size_limit = 2097152,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
    where id = 'business-files';
  end if;
end
$$;

----------------------------------------------------------------------------------------------------
-- Members' emails
----------------------------------------------------------------------------------------------------

-- business_members.email is the email a member joined with (shown in the members list). Existing
-- account members get the email of their auth user.
update app.business_members m
set email = u.email
from auth.users u
where u.id = m.user_id
  and m.kind = 'account'
  and m.email is null
  and u.email is not null;

-- Same as business_create_limit, plus the owner's email on the new membership.
create or replace function app.create_business(
  p_id uuid,
  p_legal_name text,
  p_default_locale text,
  p_owner_display_name text,
  p_owner_role_id uuid,
  p_member_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := app.current_user_id();
  v_email text;
begin
  if v_user_id is null then
    raise exception 'create_business requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.create_business:' || v_user_id::text, 0)
  );
  if (
    select pg_catalog.count(*)
    from app.businesses b
    where b.created_by = v_user_id
      and b.created_at > pg_catalog.now() - interval '24 hours'
  ) >= 10 then
    raise exception 'business_create_limit: at most 10 businesses per user in 24 hours'
      using errcode = 'BZ429';
  end if;

  select u.email into v_email from auth.users u where u.id = v_user_id;

  insert into app.businesses (id, legal_name, default_locale, created_by)
  values (p_id, p_legal_name, p_default_locale, v_user_id);

  insert into app.roles (id, business_id, name, template_key, created_by)
  values (p_owner_role_id, p_id, 'Owner', 'owner', v_user_id);

  insert into app.business_members (
    id, business_id, user_id, kind, display_name, email, status, role_id, created_by
  )
  values (
    p_member_id, p_id, v_user_id, 'account', p_owner_display_name, v_email, 'active',
    p_owner_role_id, v_user_id
  );

  return p_id;
end
$$;

comment on function app.create_business(uuid, text, text, text, uuid, uuid) is
  'Creates a business, its Owner role and the caller''s active Owner membership (at most 10 per user in 24 hours: SQLSTATE BZ429). Returns the business id.';

----------------------------------------------------------------------------------------------------
-- Invitations
----------------------------------------------------------------------------------------------------

-- Limits counted in the database, so no API path can skip them (docs/DATA_MODEL.md §4): at most 20
-- invitations per business in 24 hours (every invitation created, revoked or deleted ones included;
-- a transaction-level advisory lock per business makes concurrent invitations count each other) and
-- at most 3 resends per invitation (send_count ≤ 4). Over a limit: SQLSTATE BZ429 (`rate_limited`).
-- send_count never goes down.
create function app.invitation_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('app.invitation_limits:' || new.business_id::text, 0)
    );
    if (
      select pg_catalog.count(*)
      from app.business_invitations i
      where i.business_id = new.business_id
        and i.created_at > pg_catalog.now() - interval '24 hours'
    ) >= 20 then
      raise exception 'invitation_limit: at most 20 invitations per business in 24 hours'
        using errcode = 'BZ429';
    end if;
  elsif new.send_count < old.send_count then
    raise exception 'send_count of app.business_invitations cannot go down'
      using errcode = 'check_violation';
  end if;

  if new.send_count > 4 then
    raise exception 'invitation_resend_limit: at most 3 resends per invitation'
      using errcode = 'BZ429';
  end if;
  return new;
end
$$;

create trigger invitation_limits before insert or update on app.business_invitations
  for each row execute function app.invitation_limits();

-- Accepts an invitation for the current user (replaces the tenancy_security version). Every failure
-- about the token, the email, the role, a location or the business raises the same
-- 'invitation_invalid' (SQLSTATE BZ404), so the function never reveals whether a token exists; an
-- already active member gets 'already_member' (BZ409). New: the business must be live, the invited
-- role must not be the Owner role (ownership is only transferred), and the membership keeps the
-- verified email.
create or replace function app.accept_invitation(p_token text, p_member_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := app.current_user_id();
  v_email text;
  v_invitation app.business_invitations%rowtype;
  v_member app.business_members%rowtype;
  v_member_id uuid;
  v_display_name text;
begin
  if v_user_id is null then
    raise exception 'accept_invitation requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_user_id and u.email_confirmed_at is not null;

  select i.* into v_invitation
  from app.business_invitations i
  where i.token_hash = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    and i.status = 'pending'
    and i.deleted_at is null
    and i.expires_at > pg_catalog.now()
  for update;

  if v_invitation.id is null
    or v_email is null
    or pg_catalog.lower(v_invitation.email::text) <> pg_catalog.lower(v_email)
    or not exists (
      select 1 from app.businesses b
      where b.id = v_invitation.business_id and b.deleted_at is null
    )
    -- The role or a location may have been deleted since the invitation was sent.
    or not exists (
      select 1 from app.roles r
      where r.business_id = v_invitation.business_id
        and r.id = v_invitation.role_id
        and r.deleted_at is null
        and r.template_key is distinct from 'owner'
    )
    or exists (
      select 1
      from pg_catalog.unnest(v_invitation.location_ids) as l(id)
      where not exists (
        select 1 from app.locations x
        where x.business_id = v_invitation.business_id
          and x.id = l.id
          and x.deleted_at is null
      )
    )
  then
    raise exception 'invitation_invalid' using errcode = 'BZ404';
  end if;

  select nullif(pg_catalog.btrim(p.display_name), '') into v_display_name
  from app.profiles p
  where p.id = v_user_id and p.anonymized_at is null;
  v_display_name := coalesce(v_display_name, pg_catalog.split_part(v_email, '@', 1));

  select m.* into v_member
  from app.business_members m
  where m.business_id = v_invitation.business_id
    and m.user_id = v_user_id
    and m.deleted_at is null
  for update;

  if not found then
    insert into app.business_members (
      id, business_id, user_id, kind, display_name, email, status, role_id, created_by
    )
    values (
      p_member_id, v_invitation.business_id, v_user_id, 'account', v_display_name, v_email, 'active',
      v_invitation.role_id, v_user_id
    );
    v_member_id := p_member_id;
  elsif v_member.status = 'active' then
    raise exception 'already_member' using errcode = 'BZ409';
  else
    update app.business_members
    set status = 'active',
      role_id = v_invitation.role_id,
      display_name = v_display_name,
      email = v_email,
      permissions_version = permissions_version + 1
    where id = v_member.id;
    v_member_id := v_member.id;
  end if;

  -- The invitation's overrides and locations replace any earlier ones of a re-activated member.
  update app.member_permission_overrides o
  set deleted_at = pg_catalog.now()
  where o.business_id = v_invitation.business_id
    and o.member_id = v_member_id
    and o.deleted_at is null
    and not (v_invitation.overrides ? o.permission_key);

  insert into app.member_permission_overrides (
    id, business_id, member_id, permission_key, effect, created_by
  )
  select app.uuid_v7(), v_invitation.business_id, v_member_id, e.key, e.value, v_user_id
  from pg_catalog.jsonb_each_text(v_invitation.overrides) as e(key, value)
  on conflict (business_id, member_id, permission_key) do update
  set effect = excluded.effect, deleted_at = null
  where app.member_permission_overrides.effect is distinct from excluded.effect
    or app.member_permission_overrides.deleted_at is not null;

  update app.member_locations ml
  set deleted_at = pg_catalog.now()
  where ml.business_id = v_invitation.business_id
    and ml.member_id = v_member_id
    and ml.deleted_at is null
    and ml.location_id <> all (v_invitation.location_ids);

  insert into app.member_locations (id, business_id, member_id, location_id, created_by)
  select app.uuid_v7(), v_invitation.business_id, v_member_id, l.id, v_user_id
  from (select distinct pg_catalog.unnest(v_invitation.location_ids) as id) as l
  on conflict (business_id, member_id, location_id) do update
  set deleted_at = null
  where app.member_locations.deleted_at is not null;

  update app.business_invitations
  set status = 'accepted'
  where id = v_invitation.id;

  return v_invitation.business_id;
end
$$;

comment on function app.accept_invitation(text, uuid) is
  'Accepts a pending invitation for the current user (verified email must match; BZ404 invitation_invalid, BZ409 already_member). Returns the business id.';

-- What the invitation page shows before the invitee signs in or accepts: the business name, the
-- inviter's name, the role, the invited email masked (r•••@example.com), the expiry and, for a
-- signed-in caller, whether their verified email is the invited one. Works without a user (anonymous
-- tenant context). Only a pending invitation of a live business is shown, expired or not; any other
-- token raises 'invitation_invalid' (BZ404), so nothing tells an unknown token from a used or revoked
-- one. At most 30 previews per invitation per hour (BZ429): the counter lives on the invitation.
create function app.preview_invitation(p_token text)
returns table (
  business_name text,
  inviter_name text,
  role_name text,
  role_template_key text,
  masked_email text,
  expires_at timestamptz,
  expired boolean,
  email_matches boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := app.current_user_id();
  v_invitation app.business_invitations%rowtype;
  v_email text;
begin
  select i.* into v_invitation
  from app.business_invitations i
  join app.businesses b on b.id = i.business_id and b.deleted_at is null
  where i.token_hash = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    and i.status = 'pending'
    and i.deleted_at is null
  for update of i;

  if v_invitation.id is null then
    raise exception 'invitation_invalid' using errcode = 'BZ404';
  end if;

  if v_invitation.preview_window_started_at is null
    or v_invitation.preview_window_started_at <= pg_catalog.now() - interval '1 hour'
  then
    update app.business_invitations
    set preview_count = 1, preview_window_started_at = pg_catalog.now()
    where id = v_invitation.id;
  elsif v_invitation.preview_count >= 30 then
    raise exception 'invitation_preview_limit: at most 30 previews per invitation in an hour'
      using errcode = 'BZ429';
  else
    update app.business_invitations
    set preview_count = preview_count + 1
    where id = v_invitation.id;
  end if;

  if v_user_id is not null then
    select u.email into v_email
    from auth.users u
    where u.id = v_user_id and u.email_confirmed_at is not null;
  end if;

  return query
  select
    b.legal_name,
    (
      select nullif(pg_catalog.btrim(m.display_name), '')
      from app.business_members m
      where m.business_id = v_invitation.business_id
        and m.user_id = v_invitation.created_by
        and m.deleted_at is null
      limit 1
    ),
    r.name,
    r.template_key,
    pg_catalog.left(pg_catalog.split_part(v_invitation.email::text, '@', 1), 1)
      || '•••@' || pg_catalog.split_part(v_invitation.email::text, '@', 2),
    v_invitation.expires_at,
    v_invitation.expires_at <= pg_catalog.now(),
    case
      when v_user_id is null then null
      else coalesce(pg_catalog.lower(v_email) = pg_catalog.lower(v_invitation.email::text), false)
    end
  from app.businesses b
  left join app.roles r on r.business_id = v_invitation.business_id and r.id = v_invitation.role_id
  where b.id = v_invitation.business_id;
end
$$;

comment on function app.preview_invitation(text) is
  'Public summary of a pending invitation by its raw token (masked email; BZ404 invitation_invalid; at most 30 per invitation per hour: BZ429).';

----------------------------------------------------------------------------------------------------
-- Grants
----------------------------------------------------------------------------------------------------

alter function app.invitation_limits() owner to postgres;
alter function app.preview_invitation(text) owner to postgres;

revoke all on function app.invitation_limits() from public, anon, authenticated;
revoke all on function app.preview_invitation(text) from public, anon, authenticated;
grant execute on function app.invitation_limits() to bizcost_api;
grant execute on function app.preview_invitation(text) to bizcost_api;
