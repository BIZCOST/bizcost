-- LOCAL DEVELOPMENT ONLY: gives the API role a known password on the local Supabase stack.
-- The CLI applies this file after `supabase db reset` / `supabase db start` on the local stack. It CAN
-- also run against a hosted project (`supabase db push --include-seed`, `supabase db reset --linked`):
-- both are forbidden for BizCost (runbook, docs/ARCHITECTURE.md §Runbooks). On hosted projects
-- bizcost_api's LOGIN PASSWORD comes from a secret and is never committed; the migrations create the
-- role NOLOGIN.
-- Guard: refuse to run unless this is the CLI's local stack, recognised by the public demo JWT secret
-- that only the local stack sets as a database setting.
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '')
     <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception 'supabase/seed.sql is for the local Supabase stack only; refusing to run here';
  end if;
end
$$;

alter role bizcost_api with login password 'bizcost_local_dev';
