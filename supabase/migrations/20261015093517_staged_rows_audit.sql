-- BizCost: an import's staged rows audited by what each statement did to an import's rows, not row by
-- row (M3 Step 4 review fixes; D-262). A file of a shop's month is tens of thousands of day × item
-- totals: they are sent (addRows), then cleared when the import is finalized or deleted, and an audit
-- row for each of them on the way in and again on the way out was a third of a finalized import's time
-- (31,000 totals: 62,000 audit rows). The audit log also kept, for good, every total of every file,
-- which the import itself keeps only until it is finalized (D-253: its counts and choices, never the
-- file). Now one audit row per statement and import: who, the request, a version-7 id, the action, the
-- entity `sale_import_rows` and the import's id, with what the rows come to ({"after"} for an insert,
-- {"before"} for a delete, both for an update): how many, their first and last position, their first
-- and last day, and their quantity, amount, refunds and file rows added up. The sales the import posts
-- keep their audit row per line (app.audit_rows()); every other table is unchanged.

create function app.audit_staged_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  v_request uuid := nullif(pg_catalog.current_setting('app.request_id', true), '')::uuid;
  -- The id of each audit row: app.uuid_v7()'s expression, as app.audit_rows() writes it.
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
  -- What the rows of each import in transition table :rows come to.
  v_summary constant text := $q$(
    select r.business_id, r.import_id,
           pg_catalog.jsonb_build_object(
             'import_id', r.import_id,
             'rows', pg_catalog.count(*),
             'positions', pg_catalog.jsonb_build_array(pg_catalog.min(r.position),
                                                       pg_catalog.max(r.position)),
             'days', pg_catalog.jsonb_build_array(pg_catalog.min(r.business_date),
                                                  pg_catalog.max(r.business_date)),
             'qty', pg_catalog.sum(r.qty),
             'amount', pg_catalog.sum(r.amount),
             'refunds', pg_catalog.sum(r.refunds),
             'file_rows', pg_catalog.sum(r.file_rows)
           ) as summary
      from :rows r
     group by r.business_id, r.import_id)$q$;
begin
  if tg_op = 'INSERT' then
    execute v_columns || 'select ' || v_id || $q$, s.business_id, $1, 'insert', $2, s.import_id, $3,
        pg_catalog.jsonb_build_object('after', s.summary), pg_catalog.now()
      from $q$ || pg_catalog.replace(v_summary, ':rows', 'new_rows') || ' as s'
      using v_actor, tg_table_name::text, v_request;
  elsif tg_op = 'DELETE' then
    execute v_columns || 'select ' || v_id || $q$, s.business_id, $1, 'delete', $2, s.import_id, $3,
        pg_catalog.jsonb_build_object('before', s.summary), pg_catalog.now()
      from $q$ || pg_catalog.replace(v_summary, ':rows', 'old_rows') || ' as s'
      using v_actor, tg_table_name::text, v_request;
  else
    -- UPDATE: each import's rows before and after (a row moved to another import shows on both).
    execute v_columns || 'select ' || v_id || $q$, coalesce(n.business_id, o.business_id), $1,
        'update', $2, coalesce(n.import_id, o.import_id), $3,
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object('before', o.summary, 'after', n.summary)
        ),
        pg_catalog.now()
      from $q$ || pg_catalog.replace(v_summary, ':rows', 'old_rows') || ' as o full join '
      || pg_catalog.replace(v_summary, ':rows', 'new_rows')
      || ' as n on n.business_id = o.business_id and n.import_id = o.import_id'
      using v_actor, tg_table_name::text, v_request;
  end if;
  return null;
end
$fn$;

comment on function app.audit_staged_rows() is
  'The audit rows of one statement over app.sale_import_rows: one per import, with what its rows come to (count, positions, days, totals), never each row (D-262).';

drop trigger audit_rows_insert on app.sale_import_rows;
drop trigger audit_rows_update on app.sale_import_rows;
drop trigger audit_rows_delete on app.sale_import_rows;
create trigger audit_rows_insert after insert on app.sale_import_rows
  referencing new table as new_rows
  for each statement execute function app.audit_staged_rows();
create trigger audit_rows_update after update on app.sale_import_rows
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.audit_staged_rows();
create trigger audit_rows_delete after delete on app.sale_import_rows
  referencing old table as old_rows
  for each statement execute function app.audit_staged_rows();

alter function app.audit_staged_rows() owner to postgres;
revoke all on function app.audit_staged_rows() from public, anon, authenticated;
grant execute on function app.audit_staged_rows() to bizcost_api;
