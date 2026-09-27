-- BizCost: a password chosen before an address was confirmed does not survive its confirmation (D-102).
-- Hand-written. Anyone can sign up with someone else's address and a password of their own (the public
-- sign-up endpoint, publishable key); Supabase Auth keeps that account unconfirmed, keeps its first
-- password when the address signs up again, and keeps it when the owner of the address confirms it
-- with an emailed code: the sign-up code (their own sign-up, a resent code, or "Send me a code" on an
-- unconfirmed account) or a reset code (the reset confirms the address too, even if the owner leaves
-- before choosing a password). That password would then sign in to the owner's account.
--
-- The rule: when email_confirmed_at goes from null to a time and a code was emailed for the address
-- (confirmation_sent_at or recovery_sent_at is set), a password that was already there is replaced by
-- '' (Supabase Auth's own "no password": password sign-in fails and the user may set one). The person
-- who confirmed signs in with the code's session; the web app's sign-up then sets the password its
-- sign-up page was given, or asks for one (docs/ARCHITECTURE.md §Auth). What stays:
--   * a confirmation without any emailed code: the admin API's email_confirm, which inserts the user
--     and confirms it in one transaction (the admin chose the password);
--   * a password set by the statement that confirms the address;
--   * every change to an address that was already confirmed (sign-in codes, resets, email changes).
-- Phone sign-in is off (config.toml), so phone_confirmed_at is not covered.
--
-- Triggers on auth tables are allowed on hosted projects (the April 2025 auth-schema restrictions keep
-- them); the function lives in app. It is SECURITY INVOKER: it only changes the row being written, so
-- it runs as Supabase Auth's role and needs no grant (trigger functions are not checked for EXECUTE
-- when they fire). It never raises: an error here would fail the code check with a 500.

create function app.forget_unconfirmed_password()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.confirmation_sent_at is not null or old.recovery_sent_at is not null)
    and new.encrypted_password is not distinct from old.encrypted_password
    and coalesce(new.encrypted_password, '') <> ''
  then
    new.encrypted_password := '';
  end if;
  return new;
end
$$;

comment on function app.forget_unconfirmed_password() is
  'D-102: confirming an address with an emailed code drops a password chosen before it was confirmed.';

revoke all on function app.forget_unconfirmed_password() from public, anon, authenticated;

create trigger forget_unconfirmed_password
  before update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function app.forget_unconfirmed_password();
