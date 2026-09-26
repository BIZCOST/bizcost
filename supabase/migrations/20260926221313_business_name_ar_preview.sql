-- BizCost: the business's Arabic name on the invitation page (D-097). Hand-written: app.preview_invitation
-- also returns businesses.legal_name_ar, so an Arabic invitation page shows the Arabic name when the
-- business has one. Nothing else changes (the checks, the limit, the masked email).
--
-- A function's result columns cannot change with CREATE OR REPLACE: it is dropped and created again,
-- so the owner, the grants and the comment are set again as in settings_security.

drop function app.preview_invitation(text);

-- What the invitation page shows before the invitee signs in or accepts: the business's names, the
-- inviter's name, the role, the invited email masked (r•••@example.com), the expiry and, for a
-- signed-in caller, whether their verified email is the invited one. Works without a user (anonymous
-- tenant context). Only a pending invitation of a live business is shown, expired or not; any other
-- token raises 'invitation_invalid' (BZ404), so nothing tells an unknown token from a used or revoked
-- one. At most 30 previews per invitation per hour (BZ429): the counter lives on the invitation.
create function app.preview_invitation(p_token text)
returns table (
  business_name text,
  business_name_ar text,
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
    nullif(pg_catalog.btrim(b.legal_name_ar), ''),
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
  'Public summary of a pending invitation by its raw token (business names, masked email; BZ404 invitation_invalid; at most 30 per invitation per hour: BZ429).';

alter function app.preview_invitation(text) owner to postgres;
revoke all on function app.preview_invitation(text) from public, anon, authenticated;
grant execute on function app.preview_invitation(text) to bizcost_api;
