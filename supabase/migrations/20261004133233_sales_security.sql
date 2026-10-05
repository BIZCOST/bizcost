-- BizCost: Today's sales and One sale, finalized with their cost (M3 Step 2). Hand-written part of the
-- sales tables: row level security and the touch and audit triggers; posted sales that are never
-- edited except their fill-once costs; the books-closed date for sales; the starter sales channels of
-- the businesses that already exist; and the sales keys for the roles they already have. See
-- docs/DATA_MODEL.md §6 and DECISIONS.md (M3 Step 2, D-225–D-232).
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE; functions
-- have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE revoked from
-- PUBLIC/anon/authenticated (trigger functions run as the trigger fires).

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.sales_channels');
select app.apply_tenant_rls('app.sales');
select app.apply_tenant_rls('app.sale_lines');
select app.apply_tenant_rls('app.sale_line_materials');

create trigger touch_row before update on app.sales_channels
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.sales_channels
  for each row execute function app.audit_row();

create trigger touch_row before update on app.sales
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.sales
  for each row execute function app.audit_row();

create trigger touch_row before update on app.sale_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.sale_lines
  for each row execute function app.audit_row();

create trigger touch_row before update on app.sale_line_materials
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.sale_line_materials
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- Posted documents are never edited, but a sale's costs are filled once (D-036, D-219, D-222)
----------------------------------------------------------------------------------------------------

-- Purchases, supplier returns and credit notes as before (purchasing_security). Sales too: a draft
-- may change (it is soft-deleted when discarded) and becomes posted; a posted sale only becomes
-- reversed, and then only its reversal columns change. One fill-once on the header: a posted or
-- reversed sale whose delivery cost is still null may get one, and nothing else changes with it
-- (a member who sees costs completes it, also in a closed month; D-230). touch_row keeps
-- updated_*/version. Nothing is ever deleted.
create or replace function app.guard_posted_document()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reversal text[] := array[
    'status', 'reversed_at', 'reversed_by', 'reversal_date', 'reversal_business_date',
    'updated_at', 'updated_by', 'version'
  ];
  v_fill text[] := array['delivery_cost', 'updated_at', 'updated_by', 'version'];
  v_old jsonb;
  v_new jsonb;
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
  v_old := pg_catalog.to_jsonb(old);
  v_new := pg_catalog.to_jsonb(new);
  if old.status = 'posted' and new.status = 'reversed' and (v_old - v_reversal) = (v_new - v_reversal)
  then
    return new;
  end if;
  if tg_table_name = 'sales'
    and new.status = old.status
    and v_old -> 'delivery_cost' = 'null'::jsonb
    and v_new -> 'delivery_cost' <> 'null'::jsonb
    and (v_old - v_fill) = (v_new - v_fill)
  then
    return new;
  end if;
  raise exception 'a posted %.% is never edited: reverse it instead', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create trigger guard_posted before update or delete on app.sales
  for each row execute function app.guard_posted_document();

-- Their lines change only while the document is a draft (posting writes the lines' snapshots before
-- it marks the document posted). A sale's lines of a posted or reversed sale take only their
-- fill-once costs, each only while it is still null (D-222): a line's cost (once every material has
-- a price) and the owner's time cost (once the hourly rate is set); a material row's unit cost, cost
-- and basis (filled together by the first purchase that prices it). Nothing else, and no new row.
-- Lines are never deleted either (taken out: soft-deleted).
create or replace function app.guard_posted_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_status text;
  v_line_fill text[] := array['cost', 'time_cost', 'updated_at', 'updated_by', 'version'];
  v_material_fill text[] := array['unit_cost', 'cost', 'basis', 'updated_at', 'updated_by', 'version'];
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
  elsif tg_table_name = 'purchase_return_lines' then
    select r.status into v_status
    from app.purchase_returns r
    where r.business_id = v_business_id and r.id = new.return_id;
    if tg_op = 'UPDATE' and old.return_id is distinct from new.return_id then
      raise exception 'a return line cannot move to another return' using errcode = 'check_violation';
    end if;
  else
    -- sale_lines, sale_line_materials
    select s.status into v_status
    from app.sales s
    where s.business_id = v_business_id and s.id = new.sale_id;
    if tg_op = 'UPDATE' and old.sale_id is distinct from new.sale_id then
      raise exception 'a sale line cannot move to another sale' using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE' and v_status is not null and v_status <> 'draft' then
      if tg_table_name = 'sale_lines' then
        if (pg_catalog.to_jsonb(old) - v_line_fill) = (pg_catalog.to_jsonb(new) - v_line_fill)
          and (old.cost is null or new.cost is not distinct from old.cost)
          and (old.time_cost is null or new.time_cost is not distinct from old.time_cost)
        then
          return new;
        end if;
      elsif (pg_catalog.to_jsonb(old) - v_material_fill) = (pg_catalog.to_jsonb(new) - v_material_fill)
        and (old.cost is null
          or (new.cost is not distinct from old.cost
            and new.unit_cost is not distinct from old.unit_cost
            and new.basis is not distinct from old.basis))
      then
        return new;
      end if;
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

create trigger guard_posted before insert or update or delete on app.sale_lines
  for each row execute function app.guard_posted_lines();
create trigger guard_posted before insert or update or delete on app.sale_line_materials
  for each row execute function app.guard_posted_lines();

----------------------------------------------------------------------------------------------------
-- The books-closed date holds for sales too (D-205, D-211)
----------------------------------------------------------------------------------------------------

-- As books_closed_insert, with sales: a sale is posted only when dated after the date, reversed only
-- on a day after it (the API dates a reversal of a closed day on the first open day, D-227), also
-- when written already posted or reversed. The fill-once costs are not postings: a cost shown as
-- "no price yet" is completed also in a closed month (Q5, D-219).
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

create trigger books_closed before update on app.sales
  for each row
  when (new.status is distinct from old.status and new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();
create trigger insert_books_closed before insert on app.sales
  for each row
  when (new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();

----------------------------------------------------------------------------------------------------
-- The starter sales channels of the businesses that already exist (D-226)
----------------------------------------------------------------------------------------------------

-- New businesses get them from Smart Setup (business.createFromSetup, starterSalesChannels in
-- @bizcost/modules), named in the business's language by the i18n keys setup.sales_channels.<key>;
-- the answers, kinds and names below must equal those (an API unit test compares them). Walk-in
-- customers → "Shop", messages → "WhatsApp & phone", online → "Online"; "Direct" when none of these
-- was chosen (or the business has no stored answers). A business that already has a channel is left
-- as it is. Nothing is hosted: local and demo businesses only.
with starters (key, answer, kind, en, ar, position) as (
  values
    ('shop', 'walk_in', 'shop', 'Shop', 'المحل', 1),
    ('messages', 'messages', 'messages', 'WhatsApp & phone', 'واتساب والهاتف', 2),
    ('online', 'online', 'website', 'Online', 'عبر الإنترنت', 3)
),
pending as (
  select b.id as business_id, b.default_locale, b.created_by,
         coalesce(sa.answers -> 'sales_channels', '[]'::jsonb) as answers
    from app.businesses b
    left join app.setup_answers sa on sa.business_id = b.id and sa.deleted_at is null
   where b.deleted_at is null
     and not exists (select 1 from app.sales_channels c where c.business_id = b.id)
),
picked as (
  select p.business_id, p.default_locale, p.created_by, s.kind, s.en, s.ar, s.position
    from pending p
    join starters s on p.answers ? s.answer
  union all
  select p.business_id, p.default_locale, p.created_by, 'other', 'Direct', 'البيع المباشر', 4
    from pending p
   where not exists (select 1 from starters s where p.answers ? s.answer)
)
insert into app.sales_channels (id, business_id, name, kind, created_by)
select app.uuid_v7(), k.business_id, case k.default_locale when 'ar' then k.ar else k.en end,
       k.kind, k.created_by
  from picked k
 order by k.business_id, k.position;

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (as D-124 did for M2 Step 2)
----------------------------------------------------------------------------------------------------

-- Sales declares its permission keys now (it stays unreleased until Release A, M3 Step 6). The pairs
-- below must equal the new keys of role-templates.ts in @bizcost/modules (the plan's Q10 table,
-- D-218): Manager sees every sale, enters, finalizes, reverses and manages the channels; Accountant
-- sees every sale; Sales and Supervisor see every sale, enter and finalize; Employee enters and
-- finalizes their own. Admin holds every key. Members holding a changed role get a new
-- permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'sales.documents.view'),
    ('admin', 'sales.documents.manage'),
    ('admin', 'sales.documents.post'),
    ('admin', 'sales.documents.reverse'),
    ('admin', 'sales.channels.manage'),
    ('manager', 'sales.documents.view'),
    ('manager', 'sales.documents.manage'),
    ('manager', 'sales.documents.post'),
    ('manager', 'sales.documents.reverse'),
    ('manager', 'sales.channels.manage'),
    ('accountant', 'sales.documents.view'),
    ('sales', 'sales.documents.view'),
    ('sales', 'sales.documents.manage'),
    ('sales', 'sales.documents.post'),
    ('supervisor', 'sales.documents.view'),
    ('supervisor', 'sales.documents.manage'),
    ('supervisor', 'sales.documents.post'),
    ('employee', 'sales.documents.manage'),
    ('employee', 'sales.documents.post')
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

alter function app.guard_posted_document() owner to postgres;
alter function app.guard_posted_lines() owner to postgres;
alter function app.guard_books_closed() owner to postgres;

revoke all on function app.guard_posted_document() from public, anon, authenticated;
revoke all on function app.guard_posted_lines() from public, anon, authenticated;
revoke all on function app.guard_books_closed() from public, anon, authenticated;
grant execute on function app.guard_posted_document() to bizcost_api;
grant execute on function app.guard_posted_lines() to bizcost_api;
grant execute on function app.guard_books_closed() to bizcost_api;
