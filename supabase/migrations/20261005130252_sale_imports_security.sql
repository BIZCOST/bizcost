-- BizCost: import sales from a file, and app fees by channel (M3 Step 4). Hand-written part of the
-- import and statement tables: row level security and the touch and audit triggers; a finalized
-- import or statement that is never edited (only reversed); posted statements of a channel that never
-- cover the same day twice; the books-closed date for statements; and the import key for the roles
-- businesses already have. See docs/DATA_MODEL.md §6 and DECISIONS.md (M3 Step 4, from D-252).
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE; functions
-- have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE revoked from
-- PUBLIC/anon/authenticated (trigger functions run as the trigger fires). No file is stored: the
-- business-files bucket and app.file_uploads are unchanged (DATA_MODEL.md §1.8).

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.sale_imports');
select app.apply_tenant_rls('app.sale_import_rows');
select app.apply_tenant_rls('app.import_profiles');
select app.apply_tenant_rls('app.product_aliases');
select app.apply_tenant_rls('app.channel_statements');

create trigger touch_row before update on app.sale_imports
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.sale_imports
  for each row execute function app.audit_row();

create trigger touch_row before update on app.sale_import_rows
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.sale_import_rows
  for each row execute function app.audit_row();

create trigger touch_row before update on app.import_profiles
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.import_profiles
  for each row execute function app.audit_row();

create trigger touch_row before update on app.product_aliases
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.product_aliases
  for each row execute function app.audit_row();

create trigger touch_row before update on app.channel_statements
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.channel_statements
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- A finalized import or statement is never edited (D-036)
----------------------------------------------------------------------------------------------------

-- As for purchases and sales (guard_posted_document): a draft may change (discarded: soft-deleted)
-- and becomes posted; a posted one only becomes reversed, and then only its reversal columns change
-- (an import becomes reversed once its every sale is; a statement when it is reversed). Nothing is
-- ever deleted. The staged rows of an import (sale_import_rows) are working data, cleared when it is
-- finalized or discarded.
create trigger guard_posted before update or delete on app.sale_imports
  for each row execute function app.guard_posted_document();
create trigger guard_posted before update or delete on app.channel_statements
  for each row execute function app.guard_posted_document();

----------------------------------------------------------------------------------------------------
-- Posted statements of a channel never cover the same day twice (D-223: a line's fees come from the
-- one statement covering its day)
----------------------------------------------------------------------------------------------------

create extension if not exists btree_gist with schema extensions;

alter table app.channel_statements
  add constraint channel_statements_no_overlap
  exclude using gist (
    business_id with =,
    channel_id with =,
    daterange(period_from, period_to, '[]') with &&
  )
  where (status = 'posted' and deleted_at is null);

----------------------------------------------------------------------------------------------------
-- The books-closed date holds for statements too (the plan's S5; D-205, D-211)
----------------------------------------------------------------------------------------------------

-- As sales_security, with channel_statements: a statement's fees count over its days, so it is posted
-- or reversed only when its first day is after the date (BOOKS_CLOSED otherwise), also when written
-- already posted or reversed.
create or replace function app.guard_books_closed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_closed date;
  v_open_month date;
  v_days date[] := '{}';
  v_months date[] := '{}';
begin
  select b.books_closed_through into v_closed
  from app.businesses b
  where b.id = new.business_id
  for share;
  if v_closed is null then
    return new;
  end if;
  -- The first month left open: the month of the day after the date (a month closed only in part
  -- stays open; its closed days are checked by the day).
  v_open_month := pg_catalog.date_trunc('month', v_closed + 1)::date;

  if tg_table_name in ('purchases', 'purchase_returns', 'expenses') then
    -- Its posting: when it becomes posted, or when it is written already posted or reversed.
    if new.status = 'posted' or tg_op = 'INSERT' then
      v_days := v_days || new.business_date;
      if tg_table_name = 'expenses' then
        v_months := v_months || new.period_month;
      end if;
    end if;
    -- Its reversal: its own month, or `reversal_period_month` for an expense (D-200).
    if new.status = 'reversed' then
      v_days := v_days || new.reversal_date;
      if tg_table_name = 'expenses' then
        v_months := v_months || coalesce(new.reversal_period_month, new.period_month);
      end if;
    end if;
  elsif tg_table_name = 'sales' then
    if new.status = 'posted' or tg_op = 'INSERT' then
      v_days := v_days || new.business_date;
    end if;
    if new.status = 'reversed' then
      v_days := v_days || new.reversal_business_date;
    end if;
  elsif tg_table_name = 'channel_statements' then
    -- Posted or reversed: its every day must be open (its first day is the earliest).
    v_days := array[new.period_from];
  elsif tg_table_name in ('purchase_payments', 'expense_payments') then
    v_days := array[case when tg_op = 'INSERT' then new.business_date else new.reversal_date end];
  else
    -- stock_movements
    v_days := array[new.business_date];
  end if;

  if exists (select 1 from unnest(v_days) as d(v) where d.v <= v_closed)
     or exists (select 1 from unnest(v_months) as m(v) where m.v < v_open_month) then
    raise exception 'books_closed: %.% cannot be posted or reversed on or before %',
      tg_table_schema, tg_table_name, v_closed
      using errcode = 'BZ412';
  end if;
  return new;
end
$$;

create trigger books_closed before update on app.channel_statements
  for each row
  when (new.status is distinct from old.status and new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();
create trigger insert_books_closed before insert on app.channel_statements
  for each row
  when (new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();

----------------------------------------------------------------------------------------------------
-- The import key for the roles businesses already have (as D-124 did for M2 Step 2)
----------------------------------------------------------------------------------------------------

-- `sales.imports.manage` (import sales from a file; it needs sales.documents.manage and .post). The
-- pairs below must equal the new keys of role-templates.ts in @bizcost/modules (the plan's Q10 table:
-- the Manager imports; Admin holds every key). Members holding a changed role get a new
-- permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'sales.imports.manage'),
    ('manager', 'sales.imports.manage')
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

alter function app.guard_books_closed() owner to postgres;
revoke all on function app.guard_books_closed() from public, anon, authenticated;
grant execute on function app.guard_books_closed() to bizcost_api;
