-- BizCost: Suppliers and Purchases, posted with WAC (M2 Step 3). Hand-written part of the purchasing
-- tables: row level security, the touch and audit triggers, the append-only stock ledger, posted
-- documents that are never edited, attachments that name a record of their own business, receipts in
-- the private bucket, and the new permission keys for the roles that businesses already have. See
-- docs/DATA_MODEL.md §6 and DECISIONS.md (M2 Step 3).
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE; functions
-- have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE revoked from
-- PUBLIC/anon/authenticated (trigger functions run as the trigger fires). The grants of the tables
-- come from the default privileges of schema app; the ledger then loses UPDATE and DELETE.

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.suppliers');
select app.apply_tenant_rls('app.purchases');
select app.apply_tenant_rls('app.purchase_lines');
select app.apply_tenant_rls('app.purchase_returns');
select app.apply_tenant_rls('app.purchase_return_lines');
select app.apply_tenant_rls('app.stock_movements');
select app.apply_tenant_rls('app.material_costs');
select app.apply_tenant_rls('app.stock_balances');
select app.apply_tenant_rls('app.attachments');

create trigger touch_row before update on app.suppliers
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.suppliers
  for each row execute function app.audit_row();

create trigger touch_row before update on app.purchases
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.purchases
  for each row execute function app.audit_row();

create trigger touch_row before update on app.purchase_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.purchase_lines
  for each row execute function app.audit_row();

create trigger touch_row before update on app.purchase_returns
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.purchase_returns
  for each row execute function app.audit_row();

create trigger touch_row before update on app.purchase_return_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.purchase_return_lines
  for each row execute function app.audit_row();

create trigger touch_row before update on app.stock_movements
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.stock_movements
  for each row execute function app.audit_row();

create trigger touch_row before update on app.material_costs
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.material_costs
  for each row execute function app.audit_row();

create trigger touch_row before update on app.stock_balances
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.stock_balances
  for each row execute function app.audit_row();

create trigger touch_row before update on app.attachments
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.attachments
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- The stock ledger is append-only (D-036, D-110)
----------------------------------------------------------------------------------------------------

-- bizcost_api may only read and add movements; a correction is a new movement (a reversal). The
-- trigger also stops every other role (a change by hand would make the ledger disagree with its
-- projections, which a rebuild must equal).
revoke update, delete on app.stock_movements from bizcost_api;

create function app.forbid_ledger_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is append-only: add a reversal instead', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create trigger append_only before update or delete on app.stock_movements
  for each row execute function app.forbid_ledger_change();

----------------------------------------------------------------------------------------------------
-- Posted documents are never edited (D-036, D-114 rule 3, D-120 rule 1)
----------------------------------------------------------------------------------------------------

-- Purchases, supplier returns and credit notes. A draft may change (it is soft-deleted when
-- discarded) and becomes posted; a posted document may only become reversed, and then only its
-- reversal columns change (touch_row keeps updated_*/version). Nothing is ever deleted.
create function app.guard_posted_document()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reversal text[] := array[
    'status', 'reversed_at', 'reversed_by', 'reversal_date', 'updated_at', 'updated_by', 'version'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception '%.% rows are never deleted (a draft is discarded, a posted one reversed)',
      tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'draft' then
    if new.status = 'reversed' then
      raise exception 'a draft of %.% cannot be reversed', tg_table_schema, tg_table_name
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status = 'posted'
    and new.status = 'reversed'
    and (pg_catalog.to_jsonb(old) - v_reversal) = (pg_catalog.to_jsonb(new) - v_reversal)
  then
    return new;
  end if;
  raise exception 'a posted %.% is never edited: reverse it instead', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create trigger guard_posted before update or delete on app.purchases
  for each row execute function app.guard_posted_document();
create trigger guard_posted before update or delete on app.purchase_returns
  for each row execute function app.guard_posted_document();

-- Their lines change only while the document is a draft (posting writes the lines' snapshots before
-- it marks the document posted). Lines are never deleted either (taken out: soft-deleted).
create function app.guard_posted_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_status text;
begin
  if tg_op = 'DELETE' then
    raise exception '%.% rows are never deleted', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  v_business_id := new.business_id;
  if tg_table_name = 'purchase_lines' then
    select p.status into v_status
    from app.purchases p
    where p.business_id = v_business_id and p.id = new.purchase_id;
    if tg_op = 'UPDATE' and old.purchase_id is distinct from new.purchase_id then
      raise exception 'a purchase line cannot move to another purchase'
        using errcode = 'check_violation';
    end if;
  else
    select r.status into v_status
    from app.purchase_returns r
    where r.business_id = v_business_id and r.id = new.return_id;
    if tg_op = 'UPDATE' and old.return_id is distinct from new.return_id then
      raise exception 'a return line cannot move to another return' using errcode = 'check_violation';
    end if;
  end if;
  -- An unknown parent is left to the foreign key (it reports the right error).
  if v_status is not null and v_status <> 'draft' then
    raise exception 'lines of a posted %.% are never changed', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger guard_posted before insert or update or delete on app.purchase_lines
  for each row execute function app.guard_posted_lines();
create trigger guard_posted before insert or update or delete on app.purchase_return_lines
  for each row execute function app.guard_posted_lines();

----------------------------------------------------------------------------------------------------
-- Attachments name a record of their own business
----------------------------------------------------------------------------------------------------

-- entity + entity_id is not a foreign key (one table serves every kind of record), so this trigger
-- does its job: the record must exist in the attachment's business (a foreign_key_violation
-- otherwise), and an attachment never moves to another record.
create function app.check_attachment_target()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and (new.entity is distinct from old.entity or new.entity_id is distinct from old.entity_id)
  then
    raise exception 'an attachment cannot move to another record' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.entity = 'purchase' and not exists (
      select 1 from app.purchases p
      where p.business_id = new.business_id and p.id = new.entity_id
    ) then
      raise exception 'attachment target % % is not a record of this business',
        new.entity, new.entity_id
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end
$$;

create trigger check_target before insert or update on app.attachments
  for each row execute function app.check_attachment_target();

----------------------------------------------------------------------------------------------------
-- Uploads: receipts in the private bucket, and their own hourly limit
----------------------------------------------------------------------------------------------------

-- Receipts are photos or PDFs, often larger than a logo: the bucket now takes PDF too, up to 10 MB.
-- The API still checks each purpose's own rules (a logo: PNG, JPEG or WebP, 2 MB) before it saves a
-- path, and removes an object that breaks them.
do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is null then
    raise warning 'schema storage is missing: bucket business-files was not changed';
    return;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types'
  ) then
    update storage.buckets
    set file_size_limit = 10485760,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
    where id = 'business-files';
  end if;
end
$$;

-- At most 10 logo uploads and 100 attachment uploads per business in an hour (each purpose counted
-- on its own). A transaction-level advisory lock per business makes concurrent requests count each
-- other. Over the limit: SQLSTATE BZ429 (`rate_limited`). Replaces the settings_hardening version.
create or replace function app.file_upload_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := case new.purpose when 'logo' then 10 else 100 end;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.file_upload_limits:' || new.business_id::text, 0)
  );
  if (
    select pg_catalog.count(*)
    from app.file_uploads u
    where u.business_id = new.business_id
      and u.purpose = new.purpose
      and u.created_at > pg_catalog.now() - interval '1 hour'
  ) >= v_limit then
    raise exception 'file_upload_limit: at most % % uploads per business in an hour',
      v_limit, new.purpose
      using errcode = 'BZ429';
  end if;
  return new;
end
$$;

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (as D-124 did for Step 2)
----------------------------------------------------------------------------------------------------

-- Suppliers and Purchases declare their permission keys now (they stay unreleased until M2 Step 7).
-- Smart Setup copies the role templates of @bizcost/modules (role-templates.ts) into every new
-- business; the roles businesses already have get the same new keys here, once, as the
-- catalog_security migration did for Step 2. The pairs below must equal the templates' new keys
-- (docs/PRODUCT.md §8). Members holding a changed role get a new permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'suppliers.items.view'),
    ('admin', 'suppliers.items.manage'),
    ('admin', 'purchases.documents.view'),
    ('admin', 'purchases.documents.manage'),
    ('admin', 'purchases.documents.post'),
    ('admin', 'purchases.documents.reverse'),
    ('admin', 'purchases.books.close'),
    ('manager', 'suppliers.items.view'),
    ('manager', 'suppliers.items.manage'),
    ('manager', 'purchases.documents.view'),
    ('manager', 'purchases.documents.manage'),
    ('manager', 'purchases.documents.post'),
    ('manager', 'purchases.documents.reverse'),
    ('accountant', 'suppliers.items.view'),
    ('accountant', 'purchases.documents.view')
),
added as (
  insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
  select app.uuid_v7(), r.business_id, r.id, d.permission_key, r.created_by
  from app.roles r
  join defaults d on d.template_key = r.template_key
  where r.deleted_at is null
  on conflict (business_id, role_id, permission_key) do nothing
  returning business_id, role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select a.business_id, a.role_id from added a);

----------------------------------------------------------------------------------------------------
-- Function owners and grants
----------------------------------------------------------------------------------------------------

alter function app.forbid_ledger_change() owner to postgres;
alter function app.guard_posted_document() owner to postgres;
alter function app.guard_posted_lines() owner to postgres;
alter function app.check_attachment_target() owner to postgres;

revoke all on function app.forbid_ledger_change() from public, anon, authenticated;
revoke all on function app.guard_posted_document() from public, anon, authenticated;
revoke all on function app.guard_posted_lines() from public, anon, authenticated;
revoke all on function app.check_attachment_target() from public, anon, authenticated;
grant execute on function app.forbid_ledger_change() to bizcost_api;
grant execute on function app.guard_posted_document() to bizcost_api;
grant execute on function app.guard_posted_lines() to bizcost_api;
grant execute on function app.check_attachment_target() to bizcost_api;
