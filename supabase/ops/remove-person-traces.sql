-- What can be taken away of a person whose account is gone, for a request under the privacy policy
-- (docs/ARCHITECTURE.md §Runbooks › "A person's request"). Supabase → SQL Editor, as postgres: put the
-- address on the line marked below, in lower case, then run it. It stops while the account still exists:
-- the person deletes that first, on the account page.
--
-- Goes: the row on the beta list and its note; invitations already closed; the sign-in service's log lines.
-- Stays: the history of changes (app.audit_log) of the businesses that person was in. It is those
-- businesses' own record of who did what, and it is append-only; tell the person so. It goes with its
-- business if that business is erased (erase-business.sql).

begin;
set local session_replication_role = replica;

do $$
declare
  v_email constant text := 'person@example.com'; -- ← the address, in lower case
begin
  if exists (select 1 from auth.users u where pg_catalog.lower(u.email::text) = v_email) then
    raise exception 'this address still has an account: it is deleted on the account page first';
  end if;
  delete from app.beta_list l where pg_catalog.lower(l.email::text) = v_email;
  delete from app.business_invitations i
  where pg_catalog.lower(i.email::text) = v_email and i.status <> 'pending';
  delete from auth.audit_log_entries e
  where pg_catalog.lower(coalesce(e.payload -> 'traits' ->> 'user_email', '')) = v_email
     or pg_catalog.lower(coalesce(e.payload ->> 'actor_username', '')) = v_email;
end
$$;

commit;
