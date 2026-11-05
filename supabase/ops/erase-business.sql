-- Erases a closed business for good, for a request under the privacy policy (docs/ARCHITECTURE.md
-- §Runbooks › "A person's request"). There is no undo but a backup, and backups go after 7 days.
-- Supabase → SQL Editor, as postgres: put the business's id on the line marked below, then run it.
--
-- It stops with a message, and changes nothing, when:
--   - the business is still open: someone uses it (it closes when its last member deletes their account);
--   - it issued tax invoices or credit notes: the law keeps them at least 5 years after their tax period
--     (docs/PRODUCT.md), so it stays closed until then, and the person is told so;
--   - its files or its feedback's pictures are still in Storage: SQL cannot delete those, so delete them
--     first (the message says where), in Supabase → Storage → business-files.
--
-- Every table of schema app with a business_id, found from the catalog, so a new table comes by itself.
-- session_replication_role = replica skips the guards of posted documents, the append-only ledger, the
-- audit and the foreign keys, for this transaction only: this is the one place it is used on a hosted
-- project, and the checks above are what stand in for them.

begin;
set local session_replication_role = replica;

do $$
declare
  v_business constant uuid := '00000000-0000-0000-0000-000000000000'; -- ← the business's id
  v_table text;
  v_files bigint;
  v_picture text;
begin
  if not exists (
    select 1 from app.businesses b where b.id = v_business and b.deleted_at is not null
  ) then
    raise exception 'business % is not a closed business: nothing was changed', v_business;
  end if;
  if exists (select 1 from app.invoices i where i.business_id = v_business and i.status = 'issued')
    or exists (
      select 1 from app.credit_notes c where c.business_id = v_business and c.status = 'issued'
    )
  then
    raise exception 'business % issued tax documents, which the law keeps: nothing was changed', v_business;
  end if;
  select count(*) into v_files
  from storage.objects o
  where o.bucket_id = 'business-files' and pg_catalog.split_part(o.name, '/', 1) = v_business::text;
  if v_files > 0 then
    raise exception 'business % still has % files: delete the folder % in Storage first',
      v_business, v_files, v_business;
  end if;
  select f.image_path into v_picture
  from app.feedback f
  join storage.objects o on o.bucket_id = 'business-files' and o.name = f.image_path
  where f.from_business_id = v_business
  limit 1;
  if v_picture is not null then
    raise exception 'feedback from business % still has its picture: delete % in Storage first',
      v_business, v_picture;
  end if;

  delete from app.feedback f where f.from_business_id = v_business;
  for v_table in
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
     where n.nspname = 'app' and c.relkind = 'r'
     order by c.relname
  loop
    execute format('delete from app.%I where business_id = $1', v_table) using v_business;
  end loop;
  delete from app.businesses b where b.id = v_business;
  update app.profiles p set last_business_id = null where p.last_business_id = v_business;
end
$$;

commit;
