-- BizCost: web settings hardening (M1 Step 6, review fixes). Hand-written part: the upload registry for
-- the private bucket (RLS, triggers, the hourly limit and the Storage guard), more invitation limits
-- (per address, per inviting user), previews that are neither touched nor audited, the inviter check in
-- app.accept_invitation, and the membership anonymization of a deleted account. See
-- docs/DATA_MODEL.md §4 and docs/ARCHITECTURE.md §Auth (invitations), §Storage.
--
-- Rules as in tenancy_security: SET search_path = '' with schema-qualified names, owner postgres,
-- EXECUTE revoked from PUBLIC/anon/authenticated and granted to bizcost_api only (trigger functions
-- run as the trigger fires and need no grant). CREATE OR REPLACE keeps the owner and the grants of an
-- existing function.

----------------------------------------------------------------------------------------------------
-- Uploads to the private bucket business-files
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.file_uploads');

create trigger touch_row before update on app.file_uploads
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.file_uploads
  for each row execute function app.audit_row();

-- At most 10 upload URLs per business in an hour (every upload issued, used or not). A
-- transaction-level advisory lock per business makes concurrent requests count each other. Over the
-- limit: SQLSTATE BZ429 (`rate_limited`).
create function app.file_upload_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.file_upload_limits:' || new.business_id::text, 0)
  );
  if (
    select pg_catalog.count(*)
    from app.file_uploads u
    where u.business_id = new.business_id
      and u.created_at > pg_catalog.now() - interval '1 hour'
  ) >= 10 then
    raise exception 'file_upload_limit: at most 10 uploads per business in an hour'
      using errcode = 'BZ429';
  end if;
  return new;
end
$$;

create trigger file_upload_limits before insert on app.file_uploads
  for each row execute function app.file_upload_limits();

-- Storage writes an object of business-files only at a path the API issued, that is still `issued`
-- (not saved, refused or removed) and not expired. An upload URL issued earlier therefore cannot put
-- a file back once the logo was saved, refused or removed. Runs for whoever writes storage.objects
-- (Storage itself, with signed URLs or the secret key); SECURITY DEFINER to read app.file_uploads.
create function app.guard_business_file()
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

do $$
begin
  if pg_catalog.to_regclass('storage.objects') is null then
    raise warning 'schema storage is missing: trigger guard_business_file was not created';
    return;
  end if;
  execute 'drop trigger if exists guard_business_file on storage.objects';
  execute $sql$
    create trigger guard_business_file before insert or update on storage.objects
      for each row
      when (new.bucket_id = 'business-files')
      execute function app.guard_business_file()
  $sql$;
end
$$;

----------------------------------------------------------------------------------------------------
-- Invitations
----------------------------------------------------------------------------------------------------

-- Limits counted in the database, so no API path can skip them (docs/DATA_MODEL.md §4):
--   * at most 20 invitations per business in 24 hours (revoked or deleted ones included);
--   * at most 40 invitations per inviting user in 24 hours, in all their businesses;
--   * at most 3 resends per invitation (send_count ≤ 4);
--   * at most 4 emails per address and business in 24 hours (all its invitations, sent, resent or
--     revoked: cancelling and inviting again does not start over).
-- A transaction-level advisory lock per business makes concurrent writes count each other. Over a
-- limit: SQLSTATE BZ429 (`rate_limited`). send_count never goes down. Replaces the settings_security
-- version.
create or replace function app.invitation_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other_sends integer;
begin
  if tg_op = 'UPDATE' and new.send_count < old.send_count then
    raise exception 'send_count of app.business_invitations cannot go down'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.send_count = old.send_count then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.invitation_limits:' || new.business_id::text, 0)
  );

  if tg_op = 'INSERT' then
    if (
      select pg_catalog.count(*)
      from app.business_invitations i
      where i.business_id = new.business_id
        and i.created_at > pg_catalog.now() - interval '24 hours'
    ) >= 20 then
      raise exception 'invitation_limit: at most 20 invitations per business in 24 hours'
        using errcode = 'BZ429';
    end if;
    if (
      select pg_catalog.count(*)
      from app.business_invitations i
      where i.created_by = new.created_by
        and i.created_at > pg_catalog.now() - interval '24 hours'
    ) >= 40 then
      raise exception 'invitation_user_limit: at most 40 invitations per user in 24 hours'
        using errcode = 'BZ429';
    end if;
  end if;

  if new.send_count > 4 then
    raise exception 'invitation_resend_limit: at most 3 resends per invitation'
      using errcode = 'BZ429';
  end if;

  -- Every email of the business's invitations to this address sent in the last 24 hours (an
  -- invitation last sent then counts all its sends: never fewer than were really sent).
  select coalesce(pg_catalog.sum(i.send_count), 0) into v_other_sends
  from app.business_invitations i
  where i.business_id = new.business_id
    and pg_catalog.lower(i.email::text) = pg_catalog.lower(new.email::text)
    and i.id <> new.id
    and i.last_sent_at > pg_catalog.now() - interval '24 hours';
  if v_other_sends + new.send_count > 4 then
    raise exception 'invitation_address_limit: at most 4 invitation emails per address in 24 hours'
      using errcode = 'BZ429';
  end if;
  return new;
end
$$;

-- An invitation preview (app.preview_invitation) only counts previews: that change neither touches the
-- row (version, updated_by) nor writes the audit log. Any other change still does both.
drop trigger touch_row on app.business_invitations;
create trigger touch_row before update on app.business_invitations
  for each row
  when (
    (pg_catalog.to_jsonb(old) - '{preview_count,preview_window_started_at}'::text[])
      is distinct from
    (pg_catalog.to_jsonb(new) - '{preview_count,preview_window_started_at}'::text[])
  )
  execute function app.touch_row();

drop trigger audit_row on app.business_invitations;
create trigger audit_row after insert or delete on app.business_invitations
  for each row execute function app.audit_row('token_hash');
create trigger audit_row_update after update on app.business_invitations
  for each row
  when (
    (pg_catalog.to_jsonb(old) - '{preview_count,preview_window_started_at}'::text[])
      is distinct from
    (pg_catalog.to_jsonb(new) - '{preview_count,preview_window_started_at}'::text[])
  )
  execute function app.audit_row('token_hash');

-- Accepts an invitation for the current user (replaces the settings_security version). Every failure
-- about the token, the email, the inviter, the role, a location or the business raises the same
-- 'invitation_invalid' (SQLSTATE BZ404), so the function never reveals whether a token exists; an
-- already active member gets 'already_member' (BZ409). New: the person who sent the invitation must
-- still be an active member who may invite (the owner, or settings.members.manage from the role or an
-- allow override, without a deny override), so the invitations of a removed or demoted member stop
-- working. The API also revokes them (and those whose role the inviter can no longer grant).
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
    -- The inviter was removed, or may no longer invite.
    or not exists (
      select 1
      from app.business_members m
      left join app.roles r
        on r.business_id = m.business_id and r.id = m.role_id and r.deleted_at is null
      where m.business_id = v_invitation.business_id
        and m.user_id = v_invitation.created_by
        and m.kind = 'account'
        and m.status = 'active'
        and m.deleted_at is null
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
  'Accepts a pending invitation for the current user (verified email must match; the inviter must still be an active member who may invite; BZ404 invitation_invalid, BZ409 already_member). Returns the business id.';

----------------------------------------------------------------------------------------------------
-- Account deletion
----------------------------------------------------------------------------------------------------

-- The last step of deleting an account (after the profile is anonymized): every membership of the
-- caller, in every business and whatever its status (removed ones included, which the caller can no
-- longer write through RLS), loses the email and shows the "deleted user" name. Refuses to run for a
-- profile that is not anonymized. Returns the number of memberships changed.
create function app.anonymize_my_memberships(p_display_name text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := app.current_user_id();
  v_count integer;
begin
  if v_user_id is null or not exists (
    select 1 from app.profiles p where p.id = v_user_id and p.anonymized_at is not null
  ) then
    raise exception 'anonymize_my_memberships: only for a deleted (anonymized) account'
      using errcode = 'insufficient_privilege';
  end if;

  update app.business_members m
  set email = null, display_name = p_display_name
  where m.user_id = v_user_id
    and m.kind = 'account'
    and (m.email is not null or m.display_name is distinct from p_display_name);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

comment on function app.anonymize_my_memberships(text) is
  'Account deletion: clears the email and sets the display name of every membership of the current (anonymized) user. Returns the rows changed.';

----------------------------------------------------------------------------------------------------
-- Grants
----------------------------------------------------------------------------------------------------

alter function app.file_upload_limits() owner to postgres;
alter function app.guard_business_file() owner to postgres;
alter function app.anonymize_my_memberships(text) owner to postgres;

revoke all on function app.file_upload_limits() from public, anon, authenticated;
revoke all on function app.guard_business_file() from public, anon, authenticated;
revoke all on function app.anonymize_my_memberships(text) from public, anon, authenticated;
grant execute on function app.file_upload_limits() to bizcost_api;
grant execute on function app.anonymize_my_memberships(text) to bizcost_api;
