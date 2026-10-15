-- BizCost: Customers, Orders with delivery, customer payments, refunds and what customers owe (M3
-- Step 5). Hand-written part of the orders tables: row level security and the touch and audit
-- triggers; orders that change only while pending (a delivered one is never edited, a cancelled one
-- never changes again) and their lines likewise; customer payments that are never edited or deleted
-- (only reversed); a sale that keeps its payments and refunds (it is reversed only once they are);
-- the books-closed date for customer payments; orders' files (the customer's LPO); and the new keys
-- for the roles that businesses already have. See docs/DATA_MODEL.md §6 and DECISIONS.md (M3 Step 5,
-- from D-263).
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE; functions
-- have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE revoked from
-- PUBLIC/anon/authenticated (trigger functions run as the trigger fires).

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.customers');
select app.apply_tenant_rls('app.document_counters');
select app.apply_tenant_rls('app.orders');
select app.apply_tenant_rls('app.order_lines');
select app.apply_tenant_rls('app.customer_payments');

create trigger touch_row before update on app.customers
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.customers
  for each row execute function app.audit_row();

create trigger touch_row before update on app.document_counters
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.document_counters
  for each row execute function app.audit_row();

create trigger touch_row before update on app.orders
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.orders
  for each row execute function app.audit_row();

create trigger touch_row before update on app.order_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.order_lines
  for each row execute function app.audit_row();

create trigger touch_row before update on app.customer_payments
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.customer_payments
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- Customers and counters are never deleted
----------------------------------------------------------------------------------------------------

-- A customer is archived, never deleted (D-123); a counter is the business's for good. Neither is
-- soft-deleted by any API path either: a deleted counter would start a series over.
create function app.never_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or (old.deleted_at is null and new.deleted_at is not null) then
    raise exception '%.% rows are never deleted', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger never_delete before update or delete on app.customers
  for each row execute function app.never_delete();
create trigger never_delete before update or delete on app.document_counters
  for each row execute function app.never_delete();

-- A number given is never taken back: the counter only moves forward.
create function app.guard_document_counter()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.series is distinct from old.series or new.next_no < old.next_no then
    raise exception 'a document counter only moves forward' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger guard_counter before update on app.document_counters
  for each row execute function app.guard_document_counter();

----------------------------------------------------------------------------------------------------
-- Orders change only while pending (Q16)
----------------------------------------------------------------------------------------------------

-- A pending order may change (its number never does) and becomes delivered (only its delivery
-- columns and status change: its amounts were saved while pending) or cancelled (only its cancel
-- columns and status). A delivered order changes only back to pending ("Undo delivery": its delivery
-- columns cleared, nothing else). A cancelled order never changes again. An order with payments that
-- stand keeps its customer (they were recorded for that customer). Orders are never deleted, hard or
-- soft (a pending order is cancelled instead).
create function app.guard_order()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_delivery text[] := array[
    'status', 'delivered_on', 'sale_id', 'delivered_at', 'delivered_by',
    'updated_at', 'updated_by', 'version'
  ];
  v_cancel text[] := array[
    'status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at', 'updated_by', 'version'
  ];
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception 'app.orders rows are never deleted (a pending order is cancelled)'
      using errcode = 'restrict_violation';
  end if;
  if new.seq is distinct from old.seq or new.number is distinct from old.number
    or new.deleted_at is distinct from old.deleted_at
  then
    raise exception 'an order keeps its number and is never deleted' using errcode = 'check_violation';
  end if;
  if new.customer_id is distinct from old.customer_id and exists (
    select 1 from app.customer_payments cp
     where cp.business_id = new.business_id and cp.order_id = new.id
       and cp.reversed_at is null and cp.deleted_at is null
  ) then
    raise exception 'an order with payments keeps its customer' using errcode = 'check_violation';
  end if;
  v_old := pg_catalog.to_jsonb(old);
  v_new := pg_catalog.to_jsonb(new);
  if old.status = 'pending' then
    if new.status = 'pending' then
      return new;
    end if;
    if new.status = 'delivered' and (v_old - v_delivery) = (v_new - v_delivery) then
      return new;
    end if;
    if new.status = 'cancelled' and (v_old - v_cancel) = (v_new - v_cancel) then
      return new;
    end if;
  elsif old.status = 'delivered' then
    if new.status = 'pending' and (v_old - v_delivery) = (v_new - v_delivery) then
      return new;
    end if;
  end if;
  raise exception 'a delivered or cancelled order is never edited (undo the delivery first)'
    using errcode = 'restrict_violation';
end
$$;

create trigger guard_order before update or delete on app.orders
  for each row execute function app.guard_order();

-- An order's lines change only while it is pending (taken out: soft-deleted); never deleted, never
-- moved to another order.
create function app.guard_order_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'app.order_lines rows are never deleted' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' and old.order_id is distinct from new.order_id then
    raise exception 'an order line cannot move to another order' using errcode = 'check_violation';
  end if;
  select o.status into v_status
  from app.orders o
  where o.business_id = new.business_id and o.id = new.order_id;
  -- An unknown order is left to the foreign key (it reports the right error).
  if v_status is not null and v_status <> 'pending' then
    raise exception 'lines of a delivered or cancelled order are never changed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger guard_order_lines before insert or update or delete on app.order_lines
  for each row execute function app.guard_order_lines();

----------------------------------------------------------------------------------------------------
-- Customer payments: recorded on what is owed, never edited, only reversed (Q17; D-160)
----------------------------------------------------------------------------------------------------

-- The API checks the same (DOCUMENT_NOT_POSTED, ORDER_CANCELLED, VALIDATION); this holds it for every
-- path. A new payment stands, and names a live order (a payment towards it only while it is pending
-- or delivered; money given back on any order, a cancelled one's deposit too), or a finalized sale
-- "they'll pay later" (One sale; an order's sale owes nothing: its order does). Afterwards the only
-- change is standing → reversed, with its reversal columns. Nothing is deleted, soft or hard.
create function app.guard_customer_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reversal text[] := array[
    'reversed_at', 'reversed_by', 'reversal_date', 'updated_at', 'updated_by', 'version'
  ];
  v_status text;
  v_source text;
  v_pay_later boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'app.customer_payments rows are never deleted (a payment is reversed)'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.reversed_at is not null or new.deleted_at is not null then
      raise exception 'a new payment stands' using errcode = 'check_violation';
    end if;
    if new.order_id is not null then
      select o.status into v_status
      from app.orders o
      where o.business_id = new.business_id and o.id = new.order_id and o.deleted_at is null;
      -- An unknown order is left to the foreign key.
      if found and new.kind = 'payment' and v_status not in ('pending', 'delivered') then
        raise exception 'a payment is recorded only on a pending or delivered order'
          using errcode = 'check_violation';
      end if;
    else
      select s.status, s.source, s.pay_later into v_status, v_source, v_pay_later
      from app.sales s
      where s.business_id = new.business_id and s.id = new.sale_id and s.deleted_at is null;
      if found and (v_status <> 'posted' or v_source <> 'single' or not v_pay_later) then
        raise exception 'a payment is recorded only on a finalized sale they pay later'
          using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;
  if old.reversed_at is null
    and new.reversed_at is not null
    and (pg_catalog.to_jsonb(old) - v_reversal) = (pg_catalog.to_jsonb(new) - v_reversal)
  then
    return new;
  end if;
  raise exception 'a payment is never edited: reverse it instead'
    using errcode = 'restrict_violation';
end
$$;

create trigger guard_payment before insert or update or delete on app.customer_payments
  for each row execute function app.guard_customer_payment();

-- A sale with payments that stand, or refunds that stand, is not reversed (the API says
-- SALE_HAS_PAYMENTS and SALE_HAS_REFUNDS first): its payments and refunds are reversed first.
create function app.sales_keep_dependents()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from app.customer_payments cp
     where cp.business_id = new.business_id and cp.sale_id = new.id
       and cp.reversed_at is null and cp.deleted_at is null
  ) then
    raise exception 'a sale with payments is reversed only once its payments are'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from app.sales r
     where r.business_id = new.business_id and r.refund_of_id = new.id
       and r.status = 'posted' and r.deleted_at is null
  ) then
    raise exception 'a sale with refunds is reversed only once its refunds are'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_dependents before update on app.sales
  for each row
  when (old.status = 'posted' and new.status = 'reversed')
  execute function app.sales_keep_dependents();

----------------------------------------------------------------------------------------------------
-- The books-closed date holds for customer payments too (D-205, D-211)
----------------------------------------------------------------------------------------------------

-- As sale_imports_security, with customer_payments beside the other payments: recorded on a day after
-- the date, reversed only on a day after it.
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

-- As purchase_payments (books_closed_guard): when recorded, and when reversed.
create trigger books_closed before insert on app.customer_payments
  for each row execute function app.guard_books_closed();
create trigger books_closed_reversal before update on app.customer_payments
  for each row
  when (old.reversed_at is null and new.reversed_at is not null)
  execute function app.guard_books_closed();

----------------------------------------------------------------------------------------------------
-- Orders' files (the customer's LPO): attachments of entity `order`
----------------------------------------------------------------------------------------------------

create or replace function app.check_attachment_target()
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
    -- FOR SHARE: a discard (FOR UPDATE, then the receipts it sees) cannot run between this check
    -- and the commit of the new row.
    if new.entity = 'purchase' then
      perform 1 from app.purchases p
      where p.business_id = new.business_id and p.id = new.entity_id and p.deleted_at is null
      for share;
    elsif new.entity = 'expense' then
      perform 1 from app.expenses e
      where e.business_id = new.business_id and e.id = new.entity_id and e.deleted_at is null
      for share;
    elsif new.entity = 'order' then
      perform 1 from app.orders o
      where o.business_id = new.business_id and o.id = new.entity_id and o.deleted_at is null
      for share;
    else
      raise exception 'attachment entity % is unknown', new.entity using errcode = 'check_violation';
    end if;
    if not found then
      raise exception 'attachment target % % is not a live record of this business',
        new.entity, new.entity_id
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end
$$;

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (as D-124 did for M2 Step 2)
----------------------------------------------------------------------------------------------------

-- Customers, Orders and customer payments declare their keys now (they stay unreleased until Release
-- A, M3 Step 6). The pairs below must equal the new keys of role-templates.ts in @bizcost/modules (the
-- plan's Q10 table, D-218): the Manager sees and adds customers, sees every order, enters, delivers
-- and undoes, sees and records payments; the Accountant sees customers, every order, and sees and
-- records payments; Sales sees and adds customers, every order, enters and delivers, and sees and
-- records payments; the Supervisor the same without payments; the Employee adds customers and enters
-- and delivers their own orders. Admin holds every key. Members holding a changed role get a new
-- permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'customers.items.view'),
    ('admin', 'customers.items.manage'),
    ('admin', 'payments.customers.view'),
    ('admin', 'payments.customers.record'),
    ('admin', 'orders.documents.view'),
    ('admin', 'orders.documents.manage'),
    ('admin', 'orders.documents.deliver'),
    ('admin', 'orders.documents.reverse'),
    ('manager', 'customers.items.view'),
    ('manager', 'customers.items.manage'),
    ('manager', 'orders.documents.view'),
    ('manager', 'orders.documents.manage'),
    ('manager', 'orders.documents.deliver'),
    ('manager', 'orders.documents.reverse'),
    ('manager', 'payments.customers.view'),
    ('manager', 'payments.customers.record'),
    ('accountant', 'customers.items.view'),
    ('accountant', 'orders.documents.view'),
    ('accountant', 'payments.customers.view'),
    ('accountant', 'payments.customers.record'),
    ('sales', 'customers.items.view'),
    ('sales', 'customers.items.manage'),
    ('sales', 'orders.documents.view'),
    ('sales', 'orders.documents.manage'),
    ('sales', 'orders.documents.deliver'),
    ('sales', 'payments.customers.view'),
    ('sales', 'payments.customers.record'),
    ('supervisor', 'customers.items.view'),
    ('supervisor', 'customers.items.manage'),
    ('supervisor', 'orders.documents.view'),
    ('supervisor', 'orders.documents.manage'),
    ('supervisor', 'orders.documents.deliver'),
    ('employee', 'customers.items.manage'),
    ('employee', 'orders.documents.manage'),
    ('employee', 'orders.documents.deliver')
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

alter function app.never_delete() owner to postgres;
alter function app.guard_document_counter() owner to postgres;
alter function app.guard_order() owner to postgres;
alter function app.guard_order_lines() owner to postgres;
alter function app.guard_customer_payment() owner to postgres;
alter function app.sales_keep_dependents() owner to postgres;
alter function app.guard_books_closed() owner to postgres;
alter function app.check_attachment_target() owner to postgres;

revoke all on function app.never_delete() from public, anon, authenticated;
revoke all on function app.guard_document_counter() from public, anon, authenticated;
revoke all on function app.guard_order() from public, anon, authenticated;
revoke all on function app.guard_order_lines() from public, anon, authenticated;
revoke all on function app.guard_customer_payment() from public, anon, authenticated;
revoke all on function app.sales_keep_dependents() from public, anon, authenticated;
revoke all on function app.guard_books_closed() from public, anon, authenticated;
revoke all on function app.check_attachment_target() from public, anon, authenticated;
grant execute on function app.never_delete() to bizcost_api;
grant execute on function app.guard_document_counter() to bizcost_api;
grant execute on function app.guard_order() to bizcost_api;
grant execute on function app.guard_order_lines() to bizcost_api;
grant execute on function app.guard_customer_payment() to bizcost_api;
grant execute on function app.sales_keep_dependents() to bizcost_api;
grant execute on function app.guard_books_closed() to bizcost_api;
grant execute on function app.check_attachment_target() to bizcost_api;
