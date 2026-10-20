-- BizCost: M3 Step 8 review fixes (DECISIONS.md D-313–D-316). Hand-written. Rules as in tenancy_security
-- (search_path, owner, grants).
--
--   1. The columns invoices_review_columns added, filled on the invoices issued before it (local and
--      preview data only: Invoices is not released yet): the customer's phone as it is now (it was not
--      frozen then), and the site of the quotation an invoice was made from.
--   2. Customer payments: an order its issued invoices bill only in part still takes payments of its
--      own (they count toward its invoices first, then what is not invoiced yet); once its invoices bill
--      all of it, it is paid through them (replaces invoices_security's guard_customer_payment).
--   3. An order an issued invoice refers to keeps its branch; a quotation an issued invoice bills is
--      never made an order; an invoice is issued from its source's branch.

----------------------------------------------------------------------------------------------------
-- 1. What the earlier issued invoices did not freeze
----------------------------------------------------------------------------------------------------

alter table app.invoices disable trigger guard_invoice;

update app.invoices i
   set customer_phone = c.phone
  from app.customers c
 where c.business_id = i.business_id and c.id = i.customer_id
   and i.status = 'issued' and i.customer_phone is null and c.phone is not null;

update app.invoices i
   set site = q.site
  from app.quotations q
 where q.business_id = i.business_id and q.id = i.quotation_id
   and i.site is null and q.site is not null;

alter table app.invoices enable trigger guard_invoice;

----------------------------------------------------------------------------------------------------
-- 2. Customer payments
----------------------------------------------------------------------------------------------------

-- What an order's issued invoices still bill of it: each one's payable less its credit notes that only
-- billed less (issued before the work they bill had counted, D-305: the order bills that again).
create function app.order_billed(p_business_id uuid, p_order_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(i.payable - coalesce((
           select sum(c.total) from app.credit_notes c
            where c.business_id = i.business_id and c.invoice_id = i.id and c.status = 'issued'
              and c.deleted_at is null and c.counted_on is null and c.counted_elsewhere is null), 0)), 0)
    from app.invoices i
   where i.business_id = p_business_id and i.order_id = p_order_id and i.status = 'issued'
     and i.deleted_at is null
$$;

-- As invoices_security, and: a payment on an order that has issued invoices is refused only once they
-- bill all of it (a deposit invoice, then the delivery: the customer pays the rest on the order until
-- its final invoice). A sale an issued invoice bills is always paid through it.
create or replace function app.guard_customer_payment()
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
    if new.invoice_id is not null then
      select i.status into v_status
      from app.invoices i
      where i.business_id = new.business_id and i.id = new.invoice_id and i.deleted_at is null;
      -- An unknown invoice is left to the foreign key.
      if found and v_status <> 'issued' then
        raise exception 'a payment is recorded only on an issued invoice'
          using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if new.kind = 'payment' and new.sale_id is not null and exists (
      select 1 from app.invoices i
       where i.business_id = new.business_id and i.status = 'issued' and i.deleted_at is null
         and i.sale_id = new.sale_id
    ) then
      raise exception 'an invoiced sale is paid through its invoices'
        using errcode = 'check_violation';
    end if;
    if new.kind = 'payment' and new.order_id is not null
      and exists (
        select 1 from app.invoices i
         where i.business_id = new.business_id and i.status = 'issued' and i.deleted_at is null
           and i.order_id = new.order_id
      )
      and not exists (
        select 1 from app.orders o
         where o.business_id = new.business_id and o.id = new.order_id and o.status <> 'cancelled'
           and o.total + o.rounding_difference > app.order_billed(o.business_id, o.id)
      )
    then
      raise exception 'an order its invoices bill in full is paid through them'
        using errcode = 'check_violation';
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
      -- A payment on a finalized sale "they'll pay later"; money given back on one, or on a sale an
      -- issued invoice was made from (it was paid there, perhaps when made).
      if found
        and (v_status <> 'posted' or v_source <> 'single' or not v_pay_later)
        and (new.kind = 'payment' or not exists (
          select 1 from app.invoices i
           where i.business_id = new.business_id and i.sale_id = new.sale_id
             and i.status = 'issued' and i.deleted_at is null
        ))
      then
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

----------------------------------------------------------------------------------------------------
-- 3. Branches and orders of invoiced documents
----------------------------------------------------------------------------------------------------

-- An order an issued invoice refers to keeps its branch (Q12: its payments and its invoices are seen
-- in one branch, and its credit notes take back sales of that branch).
create function app.orders_keep_invoice_branch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from app.invoices i
     where i.business_id = new.business_id and i.order_id = new.id
       and i.status = 'issued' and i.deleted_at is null
  ) then
    raise exception 'an order an issued invoice refers to keeps its branch'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_invoice_branch before update of location_id on app.orders
  for each row
  when (old.location_id is distinct from new.location_id)
  execute function app.orders_keep_invoice_branch();

-- A quotation an issued invoice bills (any revision of it: a deposit, a stage) is invoiced from the
-- quotation to the end: it is never made an order, which would bill and count the work again (Q3).
create function app.quotations_keep_invoices()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from app.invoices i
      join app.quotations r on r.business_id = i.business_id and r.id = i.quotation_id
     where i.business_id = new.business_id and r.root_id = new.root_id
       and i.status = 'issued' and i.deleted_at is null
  ) then
    raise exception 'a quotation an issued invoice bills is not made an order'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_invoices before update of order_id on app.quotations
  for each row
  when (old.order_id is null and new.order_id is not null)
  execute function app.quotations_keep_invoices();

-- An invoice made from a quotation, an order or a sale is issued from its source's branch.
create function app.invoice_source_branch()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_location uuid;
begin
  if new.quotation_id is not null then
    select q.location_id into v_location from app.quotations q
     where q.business_id = new.business_id and q.id = new.quotation_id;
  elsif new.order_id is not null then
    select o.location_id into v_location from app.orders o
     where o.business_id = new.business_id and o.id = new.order_id;
  elsif new.sale_id is not null then
    select s.location_id into v_location from app.sales s
     where s.business_id = new.business_id and s.id = new.sale_id;
  else
    return new;
  end if;
  if v_location is distinct from new.location_id then
    raise exception 'an invoice made from a source is issued from its branch'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger source_branch before update on app.invoices
  for each row
  when (old.status = 'draft' and new.status = 'issued')
  execute function app.invoice_source_branch();

----------------------------------------------------------------------------------------------------
-- Owners and grants
----------------------------------------------------------------------------------------------------

alter function app.order_billed(uuid, uuid) owner to postgres;
alter function app.guard_customer_payment() owner to postgres;
alter function app.orders_keep_invoice_branch() owner to postgres;
alter function app.quotations_keep_invoices() owner to postgres;
alter function app.invoice_source_branch() owner to postgres;

revoke all on function app.order_billed(uuid, uuid) from public, anon, authenticated;
revoke all on function app.guard_customer_payment() from public, anon, authenticated;
revoke all on function app.orders_keep_invoice_branch() from public, anon, authenticated;
revoke all on function app.quotations_keep_invoices() from public, anon, authenticated;
revoke all on function app.invoice_source_branch() from public, anon, authenticated;

grant execute on function app.order_billed(uuid, uuid) to bizcost_api;
grant execute on function app.guard_customer_payment() to bizcost_api;
grant execute on function app.orders_keep_invoice_branch() to bizcost_api;
grant execute on function app.quotations_keep_invoices() to bizcost_api;
grant execute on function app.invoice_source_branch() to bizcost_api;
