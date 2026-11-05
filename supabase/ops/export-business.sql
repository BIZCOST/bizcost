-- A copy of one business's rows, for a request under the privacy policy (docs/ARCHITECTURE.md §Runbooks ›
-- "A person's request"). Reads only. Supabase → SQL Editor, as postgres: put the business's id on the
-- line marked below, run it, and use "Download CSV" on the result (one row per table, its rows as JSON).
-- Its files are in Storage, bucket business-files, folder {business id}. Send the copy only to an owner
-- of that business, at the address on their account.
--
-- Every table of schema app with a business_id, found from the catalog, so a new table comes by itself.
-- The hashes stay out: they are ours, and an idempotency key's or PIN's hash is nobody's data.

drop table if exists pg_temp.ops_export;
create temporary table ops_export (table_name text primary key, row_count bigint, rows jsonb);

do $$
declare
  v_business constant uuid := '00000000-0000-0000-0000-000000000000'; -- ← the business's id
  v_table text;
begin
  if not exists (select 1 from app.businesses b where b.id = v_business) then
    raise exception 'no business has the id %', v_business;
  end if;
  insert into ops_export
    select 'businesses', 1, jsonb_agg(to_jsonb(b)) from app.businesses b where b.id = v_business;
  for v_table in
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
     where n.nspname = 'app' and c.relkind = 'r'
     order by c.relname
  loop
    execute format(
      $sql$insert into ops_export
             select %L, count(*), coalesce(
               jsonb_agg(to_jsonb(x) - 'request_hash' - 'pin_hash' - 'token_hash' - 'file_hash'),
               '[]'::jsonb)
             from app.%I x where x.business_id = $1$sql$,
      v_table, v_table)
      using v_business;
  end loop;
  insert into ops_export
    select 'feedback', count(*), coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
    from app.feedback f where f.from_business_id = v_business;
end
$$;

select table_name, row_count, rows from ops_export where row_count > 0 order by table_name;
