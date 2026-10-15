-- BizCost: posting thousands of sale lines in one statement (M3 Step 4: an import finalizes a month of
-- a branch's sales at once, the plan's budget of 2 branches × 31 days × 120 products; D-259). Two
-- changes, and neither changes what is written or refused:
--
--   1. app.audit_row() works out the audit row's id and actor in place, with the very expressions of
--      app.uuid_v7() and app.current_user_id(): each call of a function with its own SET search_path
--      switched the configuration once more per audited row (about half the trigger's time).
--   2. A line or material row added to a sale is checked once per statement, AFTER INSERT over the
--      rows added (a transition table), in place of once per row BEFORE INSERT: the row check read its
--      sale under the table's row level security, whose membership check then ran for every row. UPDATE
--      and DELETE keep the row guard (they compare each row's old and new values). A line added to a
--      posted sale is refused as before (restrict_violation), the whole statement with it; an unknown
--      sale is still left to the foreign key, which reports it first.
--
-- With both, 18,600 material rows (a branch's month of 120 products of 5 materials) are written in
-- about 1.4 s instead of 4.9 s locally.

----------------------------------------------------------------------------------------------------
-- 1. The audit trigger, without nested function calls
----------------------------------------------------------------------------------------------------

create or replace function app.audit_row()
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
    -- app.uuid_v7(): 48-bit Unix time in ms over the first 6 bytes of a random v4 UUID, then
    -- version bits 0111 (the SQL-standard forms resolve to pg_catalog: it is always searched first).
    pg_catalog.encode(
      pg_catalog.set_bit(
        pg_catalog.set_bit(
          overlay(
            pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
            placing substring(
              pg_catalog.int8send(
                pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint
              ) from 3
            )
            from 1 for 6
          ),
          52, 1
        ),
        53, 1
      ),
      'hex'
    )::uuid,
    case when tg_table_name = 'businesses' then (v_row ->> 'id')::uuid else (v_row ->> 'business_id')::uuid end,
    -- app.current_user_id()
    nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid,
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

----------------------------------------------------------------------------------------------------
-- 2. Lines added to a sale: checked once per statement
----------------------------------------------------------------------------------------------------

-- The rows a statement added to sale_lines or sale_line_materials (transition table `added`) all
-- belong to draft sales; otherwise the statement fails as the row guard made it fail. Only rows of the
-- caller's business reach it (row level security checks each row as it is written).
create function app.guard_posted_lines_added()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_posted boolean;
begin
  -- EXECUTE plans the query for the statement's own number of rows.
  execute $q$
    select exists (
      select 1
      from added a
      join app.sales s on s.business_id = a.business_id and s.id = a.sale_id
      where s.status <> 'draft'
    )$q$
    into v_posted;
  if v_posted then
    raise exception 'lines of a posted %.% are never changed', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return null;
end
$$;

drop trigger guard_posted on app.sale_lines;
create trigger guard_posted before update or delete on app.sale_lines
  for each row execute function app.guard_posted_lines();
create trigger guard_posted_added after insert on app.sale_lines
  referencing new table as added
  for each statement execute function app.guard_posted_lines_added();

drop trigger guard_posted on app.sale_line_materials;
create trigger guard_posted before update or delete on app.sale_line_materials
  for each row execute function app.guard_posted_lines();
create trigger guard_posted_added after insert on app.sale_line_materials
  referencing new table as added
  for each statement execute function app.guard_posted_lines_added();

----------------------------------------------------------------------------------------------------
-- Function owners and grants
----------------------------------------------------------------------------------------------------

alter function app.guard_posted_lines_added() owner to postgres;
revoke all on function app.guard_posted_lines_added() from public, anon, authenticated;
grant execute on function app.guard_posted_lines_added() to bizcost_api;
