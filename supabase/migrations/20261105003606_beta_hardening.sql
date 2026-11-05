-- BizCost: the closed beta, after its security review (D-362). The Auth hook runs only when Auth creates
-- a user, so a sign-up that was started and never confirmed needs neither the list nor the invitation
-- any more: its row lets "Send me a code" go on, and the code makes a full account. So when what allowed
-- an address goes away, its unconfirmed row goes too. An account already confirmed stays (D-355).

-- Nothing still allows this address, and its row has never been confirmed: it goes, with its identity
-- and codes (Auth's own foreign keys). Such a row has no session, profile, membership or data of ours.
-- Called only by the two below; no grant.
create function app.drop_unconfirmed_signup(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_email is null or app.signup_allowed(p_email) then
    return;
  end if;
  delete from auth.users u
  where pg_catalog.lower(u.email::text) = pg_catalog.lower(pg_catalog.btrim(p_email))
    and u.email_confirmed_at is null;
end
$$;

revoke all on function app.drop_unconfirmed_signup(text) from public, anon, authenticated;

comment on function app.drop_unconfirmed_signup(text) is
  'Removes a sign-up started and never confirmed, once nothing allows its address (D-362).';

-- Taken off the list, the row stays with who did it. An account already made stays too; a sign-up only
-- started does not.
create or replace function app.platform_beta_remove(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := app.current_user_id();
  v_email text;
begin
  if v_user is null then
    raise exception 'platform_beta_remove requires a signed-in caller' using errcode = 'insufficient_privilege';
  end if;
  update app.beta_list l
  set removed_at = pg_catalog.now(), removed_by = v_user
  where l.id = p_id and l.removed_at is null
  returning l.email::text into v_email;
  if v_email is null then
    return false;
  end if;
  perform app.drop_unconfirmed_signup(v_email);
  return true;
end
$$;

-- However an invitation is revoked: by a member, or because the person who sent it is leaving.
create function app.drop_signup_of_revoked_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.drop_unconfirmed_signup(new.email::text);
  return null;
end
$$;

revoke all on function app.drop_signup_of_revoked_invitation() from public, anon, authenticated;

create trigger drop_signup_of_revoked_invitation
  after update of status on app.business_invitations
  for each row
  when (old.status = 'pending' and new.status = 'revoked')
  execute function app.drop_signup_of_revoked_invitation();
