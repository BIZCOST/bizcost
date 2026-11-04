-- BizCost: the first count, counts and stock on hand (M4 Step 2). Hand-written part of the count
-- tables: row level security and the touch and audit triggers; posted counts that are never edited
-- and lines that change only while their count is a draft; the books-closed date for counts; a
-- material's tracking that follows its first count; the ledger rows of a count that name its own
-- lines; and the stock keys for the roles businesses already have. See docs/DATA_MODEL.md §6 and
-- DECISIONS.md (M4 Step 2; D-339, D-340).
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE; functions
-- have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE revoked from
-- PUBLIC/anon/authenticated (trigger functions run as the trigger fires). The grants of the tables
-- come from the default privileges of schema app.

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.stock_counts');
select app.apply_tenant_rls('app.stock_count_lines');

create trigger touch_row before update on app.stock_counts
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.stock_counts
  for each row execute function app.audit_row();

create trigger touch_row before update on app.stock_count_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.stock_count_lines
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- A posted count is never edited; its lines change only while it is a draft (D-036)
----------------------------------------------------------------------------------------------------

-- The count itself as purchases and sales (guard_posted_document, as undone_order_sale_takes_no_cost
-- left it): a draft may change (it is soft-deleted when discarded) and becomes posted; a posted count
-- only becomes reversed, and then only its reversal columns change. Nothing is ever deleted.
create trigger guard_posted before update or delete on app.stock_counts
  for each row execute function app.guard_posted_document();

-- Its lines: added, saved, counted again and taken out (soft-deleted) only while the count is a draft
-- (finalizing writes what the book said and the difference before it marks the count posted). A line
-- never moves to another count, branch or material, and a later count's lines are all in its branch.
-- Lines are never deleted. The count row is read FOR SHARE: a line saved while the count is being
-- finalized waits for it (the finalize holds the count FOR UPDATE), then sees it posted and fails.
create function app.guard_count_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_kind text;
  v_location uuid;
begin
  if tg_op = 'DELETE' then
    raise exception '%.% rows are never deleted', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' and (
    old.count_id is distinct from new.count_id
    or old.location_id is distinct from new.location_id
    or old.material_id is distinct from new.material_id
  ) then
    raise exception 'a count line cannot move to another count, branch or material'
      using errcode = 'check_violation';
  end if;
  select c.status, c.kind, c.location_id into v_status, v_kind, v_location
  from app.stock_counts c
  where c.business_id = new.business_id and c.id = new.count_id
  for share;
  -- An unknown count is left to the foreign key (it reports the right error).
  if v_status is null then
    return new;
  end if;
  if v_status <> 'draft' then
    raise exception 'lines of a posted %.% are never changed', tg_table_schema, 'stock_counts'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' and v_kind = 'count' and new.location_id is distinct from v_location then
    raise exception 'a count line is in its count''s branch' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger guard_posted before insert or update or delete on app.stock_count_lines
  for each row execute function app.guard_count_lines();

----------------------------------------------------------------------------------------------------
-- The books-closed date holds for counts too (D-114 rule 6, D-205)
----------------------------------------------------------------------------------------------------

-- As orders_security, with stock_counts beside purchases: a count is finalized only when dated after
-- the date, and reversed only on a day after it (the API dates a reversal of a closed day on the first
-- open day). Its ledger rows are checked as every movement is (trigger books_closed of stock_movements).
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

  if tg_table_name in ('purchases', 'purchase_returns', 'expenses', 'stock_counts') then
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
  elsif tg_table_name in ('purchase_payments', 'expense_payments', 'customer_payments') then
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

-- When it becomes posted or reversed, and when it is written already posted or reversed.
create trigger books_closed before update on app.stock_counts
  for each row
  when (new.status is distinct from old.status and new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();
create trigger insert_books_closed before insert on app.stock_counts
  for each row
  when (new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();

----------------------------------------------------------------------------------------------------
-- A material is tracked from its first count, and only while that count stands (D-339 Q2)
----------------------------------------------------------------------------------------------------

-- `materials.stock_tracked_from` is set once, to the day of a posted opening count with a line of the
-- material, and cleared only once no posted opening of it is left (its reversal). The API marks the
-- count posted (or reversed) first, then the material, in the same transaction; anything else that
-- would change it (a script, a later procedure, a bug) is refused, so a material's stock basis (D-115)
-- always follows a count that stands.
create function app.materials_keep_tracking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.stock_tracked_from is not null then
    if old.stock_tracked_from is not null or not exists (
      select 1
      from app.stock_counts c
      join app.stock_count_lines l
        on l.business_id = c.business_id and l.count_id = c.id and l.deleted_at is null
      where c.business_id = new.business_id
        and c.kind = 'opening'
        and c.status = 'posted'
        and c.deleted_at is null
        and c.business_date = new.stock_tracked_from
        and l.material_id = new.id
    ) then
      raise exception 'material % is tracked from the day of its first count, once', new.id
        using errcode = 'check_violation';
    end if;
  elsif exists (
    select 1
    from app.stock_counts c
    join app.stock_count_lines l
      on l.business_id = c.business_id and l.count_id = c.id and l.deleted_at is null
    where c.business_id = new.business_id
      and c.kind = 'opening'
      and c.status = 'posted'
      and c.deleted_at is null
      and l.material_id = new.id
  ) then
    raise exception 'material % is tracked while its first count stands', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_tracking before update of stock_tracked_from on app.materials
  for each row when (new.stock_tracked_from is distinct from old.stock_tracked_from)
  execute function app.materials_keep_tracking();

----------------------------------------------------------------------------------------------------
-- A count's ledger rows are its own lines' (D-110)
----------------------------------------------------------------------------------------------------

-- An opening or count row, and its reversal, is the material of its count line, in its branch, and its
-- count is posted (an opening or a count row is written by the finalize, before the count is marked
-- posted: then still a draft; a reversal by the reversal, while it is posted). The composite foreign key
-- keeps the line in the same business.
create function app.check_count_movement()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_location uuid;
  v_material uuid;
  v_kind text;
  v_status text;
begin
  select l.location_id, l.material_id, c.kind, c.status
    into v_location, v_material, v_kind, v_status
  from app.stock_count_lines l
  join app.stock_counts c on c.business_id = l.business_id and c.id = l.count_id
  where l.business_id = new.business_id and l.id = new.count_line_id;
  -- An unknown line is left to the foreign key.
  if v_location is null then
    return new;
  end if;
  if v_location <> new.location_id or v_material <> new.material_id then
    raise exception 'a count''s stock movement is its line''s material in its line''s branch'
      using errcode = 'check_violation';
  end if;
  if new.kind in ('opening', 'count') and (new.kind <> v_kind or v_status <> 'draft') then
    raise exception 'a % movement is written when its % count is finalized', new.kind, new.kind
      using errcode = 'check_violation';
  end if;
  if new.kind = 'reversal' and v_status <> 'posted' then
    raise exception 'a count''s reversal is written while the count is posted'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger check_count_line before insert on app.stock_movements
  for each row when (new.count_line_id is not null)
  execute function app.check_count_movement();

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (as D-124 did for M2 Step 2)
----------------------------------------------------------------------------------------------------

-- Stock declares its permission keys now (it stays unreleased until Release A, M4 Step 5). The pairs
-- below must equal the new keys of role-templates.ts in @bizcost/modules (the plan's Q16 table,
-- D-339): Manager sees stock, counts, starts tracking and finalizes counts; Accountant and Sales see
-- stock; Supervisor sees stock and counts; Employee counts (blind, without seeing stock). Admin holds
-- every key. Members holding a changed role get a new permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'inventory.stock.view'),
    ('admin', 'inventory.counts.enter'),
    ('admin', 'inventory.counts.manage'),
    ('manager', 'inventory.stock.view'),
    ('manager', 'inventory.counts.enter'),
    ('manager', 'inventory.counts.manage'),
    ('accountant', 'inventory.stock.view'),
    ('sales', 'inventory.stock.view'),
    ('supervisor', 'inventory.stock.view'),
    ('supervisor', 'inventory.counts.enter'),
    ('employee', 'inventory.counts.enter')
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

alter function app.guard_count_lines() owner to postgres;
alter function app.guard_books_closed() owner to postgres;
alter function app.materials_keep_tracking() owner to postgres;
alter function app.check_count_movement() owner to postgres;

revoke all on function app.guard_count_lines() from public, anon, authenticated;
revoke all on function app.guard_books_closed() from public, anon, authenticated;
revoke all on function app.materials_keep_tracking() from public, anon, authenticated;
revoke all on function app.check_count_movement() from public, anon, authenticated;
grant execute on function app.guard_count_lines() to bizcost_api;
grant execute on function app.guard_books_closed() to bizcost_api;
grant execute on function app.materials_keep_tracking() to bizcost_api;
grant execute on function app.check_count_movement() to bizcost_api;
