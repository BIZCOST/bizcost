-- BizCost: tenancy and security for the M1 tables.
-- Membership helpers, bootstrap functions, triggers (touch, audit, owner invariant), RLS and grants.
-- See docs/ARCHITECTURE.md §Tenancy & security and docs/DATA_MODEL.md §1–2.
--
-- Rules for every function in schema app: SET search_path = '' with schema-qualified app/auth names,
-- owner postgres, EXECUTE revoked from PUBLIC/anon/authenticated and granted to bizcost_api only
-- (end of this file). RLS isolates businesses only; permissions live in TypeScript.

----------------------------------------------------------------------------------------------------
-- Helpers
----------------------------------------------------------------------------------------------------

-- UUIDv7 for rows the database writes itself (audit rows, rows created inside bootstrap functions).
-- Every other id comes from the client/API (newId() in @bizcost/domain).
create function app.uuid_v7()
returns uuid
language sql
volatile
set search_path = ''
as $$
  -- 48-bit Unix time in ms over the first 6 bytes of a random v4 UUID, then version bits 0111.
  -- (pg_catalog is always searched first, so the built-ins below cannot be shadowed.)
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

comment on function app.uuid_v7() is 'Time-ordered UUID (version 7) for rows written by the database itself.';

-- Membership check used by every RLS policy. SECURITY DEFINER (owner postgres, BYPASSRLS) so it can
-- read business_members without recursing into that table's own policy. Policies always call it with
-- app.current_business_id(), never a row column, so it runs once per query (InitPlan).
create function app.is_active_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.business_members m
    where m.business_id = p_business_id
      and m.user_id = app.current_user_id()
      and m.kind = 'account'
      and m.status = 'active'
      and m.deleted_at is null
  )
$$;

comment on function app.is_active_member(uuid) is
  'True when the current user has an active, non-deleted account membership in the business.';

-- Businesses the current user can open (business switcher).
create function app.my_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id
  from app.business_members m
  where m.user_id = app.current_user_id()
    and m.kind = 'account'
    and m.status = 'active'
    and m.deleted_at is null
$$;

comment on function app.my_business_ids() is
  'Ids of the businesses where the current user is an active account member.';

-- Migration-time helper: ENABLE + FORCE RLS and the one standard tenant policy. Every future tenant
-- table calls it in its migration. Not executable by any application role.
create function app.apply_tenant_rls(p_table regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute pg_catalog.format('alter table %s enable row level security', p_table);
  execute pg_catalog.format('alter table %s force row level security', p_table);
  execute pg_catalog.format('drop policy if exists tenant_isolation on %s', p_table);
  execute pg_catalog.format(
    'create policy tenant_isolation on %s as permissive for all to bizcost_api '
    'using (business_id = (select app.current_business_id()) '
    'and (select app.is_active_member(app.current_business_id()))) '
    'with check (business_id = (select app.current_business_id()) '
    'and (select app.is_active_member(app.current_business_id())))',
    p_table
  );
end
$$;

comment on function app.apply_tenant_rls(regclass) is
  'Migration helper: ENABLE + FORCE RLS and the standard tenant_isolation policy on a tenant table.';

----------------------------------------------------------------------------------------------------
-- Row maintenance and audit triggers
----------------------------------------------------------------------------------------------------

-- BEFORE UPDATE on businesses and every tenant table: keeps updated_at/updated_by/version and makes the
-- identity and creation columns immutable. The API updates with `WHERE version = :expected`.
create function app.touch_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'id, created_by and created_at of %.% cannot change', tg_table_schema, tg_table_name
      using errcode = 'check_violation';
  end if;

  -- businesses is the tenant root and has no business_id column.
  if tg_table_name <> 'businesses' then
    if new.business_id is distinct from old.business_id then
      raise exception 'business_id of %.% cannot change', tg_table_schema, tg_table_name
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := pg_catalog.now();
  new.updated_by := app.current_user_id();
  new.version := old.version + 1;
  return new;
end
$$;

create function app.touch_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'id and created_at of app.profiles cannot change' using errcode = 'check_violation';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end
$$;

-- AFTER INSERT/UPDATE/DELETE on businesses and every tenant table, so no write can skip the audit log.
-- Trigger arguments name columns that must never be copied into audit_log (secrets such as token_hash).
create function app.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hidden text[] := coalesce(tg_argv, '{}'::text[]);
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op <> 'INSERT' then
    v_before := pg_catalog.to_jsonb(old) - v_hidden;
    v_changes := v_changes || pg_catalog.jsonb_build_object('before', v_before);
  end if;
  if tg_op <> 'DELETE' then
    v_after := pg_catalog.to_jsonb(new) - v_hidden;
    v_changes := v_changes || pg_catalog.jsonb_build_object('after', v_after);
  end if;
  v_row := coalesce(v_after, v_before);

  insert into app.audit_log (
    id, business_id, actor_user_id, action, entity, entity_id, request_id, changes, created_at
  )
  values (
    app.uuid_v7(),
    case when tg_table_name = 'businesses' then (v_row ->> 'id')::uuid else (v_row ->> 'business_id')::uuid end,
    app.current_user_id(),
    pg_catalog.lower(tg_op),
    tg_table_name,
    (v_row ->> 'id')::uuid,
    nullif(pg_catalog.current_setting('app.request_id', true), '')::uuid,
    v_changes,
    pg_catalog.now()
  );
  return null;
end
$$;

-- Invariant: every business that is not soft-deleted keeps at least one active account member whose
-- role has template_key 'owner'. Deferred constraint trigger, checked at commit, so an ownership
-- transfer can demote and promote in one transaction. It fires on every business_members write, on
-- roles when template_key/deleted_at change, and on businesses when a soft-deleted one is restored.
--
-- Concurrency. Two transactions that each remove a different one of the last two owners must not both
-- commit, in any isolation level the API role can choose:
--   1. An advisory lock serialises the checks of one business until the transaction ends. Every
--      transaction that changes ownership runs this check, so none of them can commit during ours.
--   2. The owner (and the exemption) we rely on is confirmed with FOR SHARE NOWAIT. In REPEATABLE READ
--      and SERIALIZABLE the check reads the transaction snapshot, which can be stale: locking a row that
--      a concurrent, already committed transaction changed raises serialization_failure (40001).
--      In READ COMMITTED each statement sees every commit, and the lock re-checks the latest version.
--   3. A row locked by a transaction that is still running (lock_not_available) is trusted as we see
--      it: that transaction has not run its own check yet (it would hold the advisory lock), and it
--      runs it after our commit, where step 2 makes it see our change. Never waiting on row locks
--      while holding the advisory lock also rules out lock waits in a cycle.
create function app.enforce_active_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_deleted_at timestamptz;
  v_candidate uuid;
  v_stale boolean := false;
begin
  if tg_table_name = 'businesses' then
    v_business_id := new.id;
  elsif tg_op = 'DELETE' then
    v_business_id := old.business_id;
  else
    v_business_id := new.business_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.enforce_active_owner:' || v_business_id::text, 0)
  );

  select b.deleted_at into v_deleted_at from app.businesses b where b.id = v_business_id;
  if not found then
    return null;
  end if;

  -- Soft-deleted businesses are exempt, once the deletion is confirmed (a concurrent restore would
  -- make it stale).
  if v_deleted_at is not null then
    begin
      perform 1 from app.businesses b
      where b.id = v_business_id and b.deleted_at is not null
      for share nowait;
      if found then
        return null;
      end if;
    exception
      when lock_not_available then
        return null;
      when serialization_failure then
        v_stale := true;
    end;
  end if;

  for v_candidate in
    select m.id
    from app.business_members m
    join app.roles r on r.business_id = m.business_id and r.id = m.role_id
    where m.business_id = v_business_id
      and m.kind = 'account'
      and m.status = 'active'
      and m.deleted_at is null
      and r.template_key = 'owner'
      and r.deleted_at is null
  loop
    begin
      perform 1
      from app.business_members m
      join app.roles r on r.business_id = m.business_id and r.id = m.role_id
      where m.business_id = v_business_id
        and m.id = v_candidate
        and m.kind = 'account'
        and m.status = 'active'
        and m.deleted_at is null
        and r.template_key = 'owner'
        and r.deleted_at is null
      for share of m, r nowait;
      if found then
        return null;
      end if;
    exception
      when lock_not_available then
        return null;
      when serialization_failure then
        v_stale := true;
    end;
  end loop;

  if v_stale then
    raise exception 'business % owner check read stale rows; retry the transaction', v_business_id
      using errcode = 'serialization_failure';
  end if;
  raise exception 'business % must keep at least one active owner', v_business_id
    using errcode = 'check_violation';
end
$$;

----------------------------------------------------------------------------------------------------
-- Bootstrap functions (writes that RLS would otherwise block)
----------------------------------------------------------------------------------------------------

-- Creates a business with its Owner role and the caller's active Owner membership. Owner permissions
-- are implicit (template_key 'owner'), so no role_permissions rows. Smart Setup (Step 5) later adds the
-- default location and the other role templates. Ids come from the API (UUIDv7).
create function app.create_business(
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
begin
  if v_user_id is null then
    raise exception 'create_business requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;

  insert into app.businesses (id, legal_name, default_locale, created_by)
  values (p_id, p_legal_name, p_default_locale, v_user_id);

  insert into app.roles (id, business_id, name, template_key, created_by)
  values (p_owner_role_id, p_id, 'Owner', 'owner', v_user_id);

  insert into app.business_members (
    id, business_id, user_id, kind, display_name, status, role_id, created_by
  )
  values (
    p_member_id, p_id, v_user_id, 'account', p_owner_display_name, 'active', p_owner_role_id, v_user_id
  );

  return p_id;
end
$$;

comment on function app.create_business(uuid, text, text, text, uuid, uuid) is
  'Creates a business, its Owner role and the caller''s active Owner membership. Returns the business id.';

-- Accepts an invitation for the current user. p_token is the raw token from the email; only its
-- SHA-256 hex is stored. The caller's VERIFIED auth email must equal the invitation email. Every
-- failure about the token or the email raises the same 'invitation_invalid' error, so the function
-- does not reveal whether a token exists. Returns the business id.
create function app.accept_invitation(p_token text, p_member_id uuid)
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
    -- The role or a location may have been deleted since the invitation was sent.
    or not exists (
      select 1 from app.roles r
      where r.business_id = v_invitation.business_id
        and r.id = v_invitation.role_id
        and r.deleted_at is null
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
    raise exception 'invitation_invalid';
  end if;

  select nullif(pg_catalog.btrim(p.display_name), '') into v_display_name
  from app.profiles p
  where p.id = v_user_id;
  v_display_name := coalesce(v_display_name, pg_catalog.split_part(v_email, '@', 1));

  select m.* into v_member
  from app.business_members m
  where m.business_id = v_invitation.business_id
    and m.user_id = v_user_id
    and m.deleted_at is null
  for update;

  if not found then
    insert into app.business_members (
      id, business_id, user_id, kind, display_name, status, role_id, created_by
    )
    values (
      p_member_id, v_invitation.business_id, v_user_id, 'account', v_display_name, 'active',
      v_invitation.role_id, v_user_id
    );
    v_member_id := p_member_id;
  elsif v_member.status = 'active' then
    raise exception 'already_member';
  else
    update app.business_members
    set status = 'active',
      role_id = v_invitation.role_id,
      display_name = v_display_name,
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
  'Accepts a pending invitation for the current user (verified email must match). Returns the business id.';

----------------------------------------------------------------------------------------------------
-- Triggers
----------------------------------------------------------------------------------------------------

create trigger touch_row before update on app.businesses
  for each row execute function app.touch_row();
create trigger touch_row before update on app.business_capabilities
  for each row execute function app.touch_row();
create trigger touch_row before update on app.business_modules
  for each row execute function app.touch_row();
create trigger touch_row before update on app.locations
  for each row execute function app.touch_row();
create trigger touch_row before update on app.roles
  for each row execute function app.touch_row();
create trigger touch_row before update on app.role_permissions
  for each row execute function app.touch_row();
create trigger touch_row before update on app.business_members
  for each row execute function app.touch_row();
create trigger touch_row before update on app.member_permission_overrides
  for each row execute function app.touch_row();
create trigger touch_row before update on app.member_locations
  for each row execute function app.touch_row();
create trigger touch_row before update on app.business_invitations
  for each row execute function app.touch_row();
create trigger touch_row before update on app.setup_answers
  for each row execute function app.touch_row();

create trigger touch_profile before update on app.profiles
  for each row execute function app.touch_profile();

create trigger audit_row after insert or update or delete on app.businesses
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.business_capabilities
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.business_modules
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.locations
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.roles
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.role_permissions
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.business_members
  for each row execute function app.audit_row('pin_hash');
create trigger audit_row after insert or update or delete on app.member_permission_overrides
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.member_locations
  for each row execute function app.audit_row();
create trigger audit_row after insert or update or delete on app.business_invitations
  for each row execute function app.audit_row('token_hash');
create trigger audit_row after insert or update or delete on app.setup_answers
  for each row execute function app.audit_row();

create constraint trigger enforce_active_owner
  after insert or update or delete on app.business_members
  deferrable initially deferred
  for each row execute function app.enforce_active_owner();
create constraint trigger enforce_active_owner
  after update of template_key, deleted_at on app.roles
  deferrable initially deferred
  for each row execute function app.enforce_active_owner();
-- A restored business must have an owner again (while soft-deleted it was exempt).
create constraint trigger enforce_active_owner
  after update of deleted_at on app.businesses
  deferrable initially deferred
  for each row
  when (old.deleted_at is not null and new.deleted_at is null)
  execute function app.enforce_active_owner();

----------------------------------------------------------------------------------------------------
-- Row level security
----------------------------------------------------------------------------------------------------

-- Tenant tables: the one standard policy.
select app.apply_tenant_rls('app.business_capabilities');
select app.apply_tenant_rls('app.business_modules');
select app.apply_tenant_rls('app.locations');
select app.apply_tenant_rls('app.roles');
select app.apply_tenant_rls('app.role_permissions');
select app.apply_tenant_rls('app.business_members');
select app.apply_tenant_rls('app.member_permission_overrides');
select app.apply_tenant_rls('app.member_locations');
select app.apply_tenant_rls('app.business_invitations');
select app.apply_tenant_rls('app.setup_answers');
-- For audit_log the policy only filters reads: bizcost_api holds SELECT alone (Grants below).
select app.apply_tenant_rls('app.audit_log');

-- business_members: reads also include the caller's own memberships in every business (business
-- switcher). Permissive policies are OR-ed per command, so this widens SELECT only; writes stay
-- tenant-scoped. The predicate repeats the standard one so every policy on the table carries it
-- (pgTAP catalog check).
create policy own_memberships on app.business_members
  as permissive for select to bizcost_api
  using (
    (
      business_id = (select app.current_business_id())
      and (select app.is_active_member(app.current_business_id()))
    )
    or user_id = (select app.current_user_id())
  );

-- profiles: own row only; no DELETE (accounts are anonymized, never deleted).
alter table app.profiles enable row level security;
alter table app.profiles force row level security;
create policy own_profile_select on app.profiles
  as permissive for select to bizcost_api
  using (id = (select app.current_user_id()));
create policy own_profile_insert on app.profiles
  as permissive for insert to bizcost_api
  with check (id = (select app.current_user_id()));
create policy own_profile_update on app.profiles
  as permissive for update to bizcost_api
  using (id = (select app.current_user_id()))
  with check (id = (select app.current_user_id()));

-- businesses: read every business the caller is an active member of; update only the current one.
-- No INSERT/DELETE policy: creation goes through app.create_business().
-- `= any (array(...))` is `in (select ...)` planned as an InitPlan (once per query, PK index usable)
-- instead of a hashed SubPlan.
alter table app.businesses enable row level security;
alter table app.businesses force row level security;
create policy member_businesses_select on app.businesses
  as permissive for select to bizcost_api
  using (id = any (array(select app.my_business_ids())));
create policy current_business_update on app.businesses
  as permissive for update to bizcost_api
  using (
    id = (select app.current_business_id())
    and (select app.is_active_member(app.current_business_id()))
  )
  with check (
    id = (select app.current_business_id())
    and (select app.is_active_member(app.current_business_id()))
  );

----------------------------------------------------------------------------------------------------
-- Grants
----------------------------------------------------------------------------------------------------

-- Schema app is not exposed to the Data API, and the API roles of Supabase get nothing on it.
revoke all on schema app from public, anon, authenticated;
revoke all on all tables in schema app from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;

grant usage on schema app to bizcost_api;
grant select, insert, update, delete on all tables in schema app to bizcost_api;
-- Read-only for the API: only the audit trigger (app.audit_row(), owner postgres) writes audit rows, so
-- actor, entity, request id and time cannot be forged, and rows are never changed or removed.
revoke insert, update, delete on app.audit_log from bizcost_api;

-- Future tables get the same grants. An append-only table must revoke UPDATE/DELETE in its migration.
alter default privileges for role postgres in schema app
  grant select, insert, update, delete on tables to bizcost_api;

alter function app.is_active_member(uuid) owner to postgres;
alter function app.my_business_ids() owner to postgres;
alter function app.audit_row() owner to postgres;
alter function app.enforce_active_owner() owner to postgres;
alter function app.create_business(uuid, text, text, text, uuid, uuid) owner to postgres;
alter function app.accept_invitation(text, uuid) owner to postgres;

grant execute on all functions in schema app to bizcost_api;
revoke all on function app.apply_tenant_rls(regclass) from bizcost_api;
