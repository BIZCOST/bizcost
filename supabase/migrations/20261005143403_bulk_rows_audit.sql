-- BizCost: the audit log of the tables written thousands of rows at a time, per statement (M3 Step 4;
-- D-259). An import's finalizing writes a month of a branch's sale lines and the materials each used
-- (3,720 lines and 18,600 material rows for 120 products of 5 materials) and clears its staged rows;
-- one audit insert per row was most of its time. For app.sale_lines, app.sale_line_materials and
-- app.sale_import_rows the audit rows are written by one INSERT … SELECT per statement over its
-- transition tables (app.audit_rows()), and they are the very rows app.audit_row() writes: one per row,
-- with its id (version 7, by the same expression), business, actor, action, entity, row id, request
-- id, time and changes ({"after"} for an insert, {"before"} for a delete, both for an update). Every
-- other table keeps app.audit_row() per row. The catalog check (00_catalog_coverage) accepts either.

create function app.audit_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_hidden text[] := coalesce(tg_argv, '{}'::text[]);
  v_actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  v_request uuid := nullif(pg_catalog.current_setting('app.request_id', true), '')::uuid;
  -- The id of each audit row: app.uuid_v7()'s expression (48-bit Unix time in ms over the first 6
  -- bytes of a random v4 UUID, then version bits 0111), worked out per row.
  v_id constant text := $q$
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
    )::uuid$q$;
  v_columns constant text :=
    'insert into app.audit_log (id, business_id, actor_user_id, action, entity, entity_id, '
    || 'request_id, changes, created_at) ';
begin
  -- EXECUTE plans each statement's query for its own number of rows (a plan cached for one row would
  -- pair thousands of old and new rows one by one).
  if tg_op = 'INSERT' then
    execute v_columns || 'select ' || v_id || $q$, n.business_id, $1, 'insert', $2, n.id, $3,
        pg_catalog.jsonb_build_object('after', pg_catalog.to_jsonb(n) - $4), pg_catalog.now()
      from new_rows n$q$
      using v_actor, tg_table_name::text, v_request, v_hidden;
  elsif tg_op = 'DELETE' then
    execute v_columns || 'select ' || v_id || $q$, o.business_id, $1, 'delete', $2, o.id, $3,
        pg_catalog.jsonb_build_object('before', pg_catalog.to_jsonb(o) - $4), pg_catalog.now()
      from old_rows o$q$
      using v_actor, tg_table_name::text, v_request, v_hidden;
  else
    -- UPDATE: a row's id never changes (touch_row), so its old and new rows pair by id.
    execute v_columns || 'select ' || v_id || $q$, n.business_id, $1, 'update', $2, n.id, $3,
        pg_catalog.jsonb_build_object(
          'before', pg_catalog.to_jsonb(o) - $4,
          'after', pg_catalog.to_jsonb(n) - $4
        ),
        pg_catalog.now()
      from old_rows o
      join new_rows n on n.id = o.id$q$
      using v_actor, tg_table_name::text, v_request, v_hidden;
  end if;
  return null;
end
$fn$;

comment on function app.audit_rows() is
  'The audit rows of one statement over its transition tables (old_rows, new_rows): those app.audit_row() writes per row. For tenant tables written in bulk.';

-- The three tables: their row trigger gives way to one per statement and event (a trigger with
-- transition tables takes one event).
drop trigger audit_row on app.sale_lines;
create trigger audit_rows_insert after insert on app.sale_lines
  referencing new table as new_rows
  for each statement execute function app.audit_rows();
create trigger audit_rows_update after update on app.sale_lines
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.audit_rows();
create trigger audit_rows_delete after delete on app.sale_lines
  referencing old table as old_rows
  for each statement execute function app.audit_rows();

drop trigger audit_row on app.sale_line_materials;
create trigger audit_rows_insert after insert on app.sale_line_materials
  referencing new table as new_rows
  for each statement execute function app.audit_rows();
create trigger audit_rows_update after update on app.sale_line_materials
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.audit_rows();
create trigger audit_rows_delete after delete on app.sale_line_materials
  referencing old table as old_rows
  for each statement execute function app.audit_rows();

drop trigger audit_row on app.sale_import_rows;
create trigger audit_rows_insert after insert on app.sale_import_rows
  referencing new table as new_rows
  for each statement execute function app.audit_rows();
create trigger audit_rows_update after update on app.sale_import_rows
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.audit_rows();
create trigger audit_rows_delete after delete on app.sale_import_rows
  referencing old table as old_rows
  for each statement execute function app.audit_rows();

alter function app.audit_rows() owner to postgres;
revoke all on function app.audit_rows() from public, anon, authenticated;
grant execute on function app.audit_rows() to bizcost_api;
