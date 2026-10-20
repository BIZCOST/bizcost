-- BizCost: the database guards of M3 Step 10's closing review (DECISIONS.md D-333, D-335). Hand-written.
-- Rules as in tenancy_security (search_path, owner, grants). supabase/tests/30_m3_step10_review.test.sql
-- found each as a failing test (D-205's and D-211's rule, restated by D-330: no path puts into the
-- books what the API's checks keep out).
--
--   1. A discarded (soft-deleted) draft is what it is, never "unknown": orders_keep_their_sale (D-330)
--      and guard_customer_payment read it as missing and left it to the foreign key, which accepts it
--      (the row is still there). An order is not delivered with a discarded draft sale, and a payment
--      is not recorded on a discarded draft invoice, sale or order. A truly unknown id (another
--      business's, or none) is still left to the foreign key.
--   2. Invoices and credit notes are numbered without a gap (Q25, D-304): their counter moves one number
--      at a time once started (it only refused going back), and a document is issued (by update, or
--      written already issued) only as its series' first number or the one after a number issued.
--   3. A credit note takes back the invoice's rounding difference with the rest of it (D-333): the
--      column credit_note_rounding added, filled on the credit notes issued before it that left
--      nothing of their invoice to credit; what an order's issued invoices still bill counts it.

----------------------------------------------------------------------------------------------------
-- 1. An order and a discarded draft of a sale
----------------------------------------------------------------------------------------------------

-- As orders_and_imports_guards, and a discarded draft sale is refused (it counts nowhere).
create or replace function app.orders_keep_their_sale()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_source text;
  v_order_id uuid;
  v_discarded boolean;
begin
  if new.status = 'delivered' then
    select s.status, s.source, s.order_id, s.deleted_at is not null
      into v_status, v_source, v_order_id, v_discarded
    from app.sales s
    where s.business_id = new.business_id and s.id = new.sale_id;
    -- An unknown sale (or another business's) is left to the foreign key.
    if found and (v_discarded or v_status <> 'posted' or v_source <> 'order'
                  or v_order_id is distinct from new.id) then
      raise exception 'an order is delivered only with its own finalized sale'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'delivered' then
    select s.status into v_status
    from app.sales s
    where s.business_id = old.business_id and s.id = old.sale_id;
    if found and v_status <> 'reversed' then
      raise exception 'an order goes back to pending only once the sale of its delivery is reversed'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end
$$;

----------------------------------------------------------------------------------------------------
-- 1. A payment and a discarded draft of its document
----------------------------------------------------------------------------------------------------

-- What an order's issued invoices still bill of it: each one's payable less its credit notes that only
-- billed less (D-305), each with the rounding difference it took back (D-333).
create or replace function app.order_billed(p_business_id uuid, p_order_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(i.payable - coalesce((
           select sum(c.total + c.rounding_difference) from app.credit_notes c
            where c.business_id = i.business_id and c.invoice_id = i.id and c.status = 'issued'
              and c.deleted_at is null and c.counted_on is null and c.counted_elsewhere is null), 0)), 0)
    from app.invoices i
   where i.business_id = p_business_id and i.order_id = p_order_id and i.status = 'issued'
     and i.deleted_at is null
$$;

-- As invoices_review_guards, and the document a payment names is read whether discarded or not: a
-- discarded draft invoice, sale or order is refused (a payment there would count nowhere but in the
-- customer's statement).
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
  v_discarded boolean;
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
      select i.status, i.deleted_at is not null into v_status, v_discarded
      from app.invoices i
      where i.business_id = new.business_id and i.id = new.invoice_id;
      -- An unknown invoice is left to the foreign key.
      if found and (v_discarded or v_status <> 'issued') then
        raise exception 'a payment is recorded only on a live issued invoice'
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
      select o.status, o.deleted_at is not null into v_status, v_discarded
      from app.orders o
      where o.business_id = new.business_id and o.id = new.order_id;
      -- An unknown order is left to the foreign key.
      if found and (v_discarded
                    or (new.kind = 'payment' and v_status not in ('pending', 'delivered'))) then
        raise exception 'a payment is recorded only on a pending or delivered order'
          using errcode = 'check_violation';
      end if;
    else
      select s.status, s.source, s.pay_later, s.deleted_at is not null
        into v_status, v_source, v_pay_later, v_discarded
      from app.sales s
      where s.business_id = new.business_id and s.id = new.sale_id;
      -- A payment on a finalized sale "they'll pay later"; money given back on one, or on a sale an
      -- issued invoice was made from (it was paid there, perhaps when made).
      if found and (
        v_discarded
        or ((v_status <> 'posted' or v_source <> 'single' or not v_pay_later)
            and (new.kind = 'payment' or not exists (
              select 1 from app.invoices i
               where i.business_id = new.business_id and i.sale_id = new.sale_id
                 and i.status = 'issued' and i.deleted_at is null
            )))
      ) then
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
-- 2. Invoice and credit-note numbers without a gap
----------------------------------------------------------------------------------------------------

-- As quotations_security, and the counter of a gapless series (invoices, credit notes) moves one
-- number at a time: takeNumber only ever adds one. Orders and quotations may skip (they say so).
create or replace function app.guard_document_counter()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.series is distinct from old.series then
    raise exception 'a document counter keeps its series' using errcode = 'check_violation';
  end if;
  if old.next_no = old.first_no and new.next_no = new.first_no then
    return new;
  end if;
  if new.first_no is distinct from old.first_no or new.next_no < old.next_no then
    raise exception 'a document counter only moves forward; its first number is set before its first document'
      using errcode = 'check_violation';
  end if;
  if new.series in ('invoice', 'credit_note') and new.next_no > old.next_no + 1 then
    raise exception 'an invoice or credit note counter moves one number at a time (no gap)'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- An invoice or a credit note is issued only as the next number of its series: its series' first
-- number while none of the series is issued below it, or the number after one issued. With the unique
-- number, the issued numbers of a series are always first, first + 1, … with none missing. AFTER the
-- row (and its statement's other rows) is written, so a statement that takes the counter's number and
-- issues with it, or issues several in order, is checked as it ends.
create function app.keep_series_gapless()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_series text := case tg_table_name when 'invoices' then 'invoice' else 'credit_note' end;
  v_first int;
  v_below boolean;
  v_before boolean;
begin
  select c.first_no into v_first
  from app.document_counters c
  where c.business_id = new.business_id and c.series = v_series and c.deleted_at is null;
  if not found then
    v_first := 1;
  end if;
  if tg_table_name = 'invoices' then
    select exists (select 1 from app.invoices i
                    where i.business_id = new.business_id and i.status = 'issued'
                      and i.seq < new.seq),
           exists (select 1 from app.invoices i
                    where i.business_id = new.business_id and i.status = 'issued'
                      and i.seq = new.seq - 1)
      into v_below, v_before;
  else
    select exists (select 1 from app.credit_notes c
                    where c.business_id = new.business_id and c.status = 'issued'
                      and c.seq < new.seq),
           exists (select 1 from app.credit_notes c
                    where c.business_id = new.business_id and c.status = 'issued'
                      and c.seq = new.seq - 1)
      into v_below, v_before;
  end if;
  if not ((new.seq = v_first and not v_below) or v_before) then
    raise exception 'an invoice or credit note is issued with the next number of its series (no gap)'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create trigger keep_series_gapless after insert on app.invoices
  for each row
  when (new.status = 'issued')
  execute function app.keep_series_gapless();
create trigger keep_series_gapless_issue after update on app.invoices
  for each row
  when (old.status is distinct from 'issued' and new.status = 'issued')
  execute function app.keep_series_gapless();
create trigger keep_series_gapless after insert on app.credit_notes
  for each row
  when (new.status = 'issued')
  execute function app.keep_series_gapless();
create trigger keep_series_gapless_issue after update on app.credit_notes
  for each row
  when (old.status is distinct from 'issued' and new.status = 'issued')
  execute function app.keep_series_gapless();

----------------------------------------------------------------------------------------------------
-- 3. The rounding difference a credit note took back (local and preview data)
----------------------------------------------------------------------------------------------------

-- The credit note issued last of an invoice whose credit notes take back all of its total.
alter table app.credit_notes disable trigger guard_credit_note;

update app.credit_notes c
   set rounding_difference = i.rounding_difference
  from app.invoices i
 where i.business_id = c.business_id and i.id = c.invoice_id
   and c.status = 'issued' and c.deleted_at is null and i.rounding_difference <> 0
   and i.total = (select sum(x.total) from app.credit_notes x
                   where x.business_id = c.business_id and x.invoice_id = c.invoice_id
                     and x.status = 'issued' and x.deleted_at is null)
   and c.id = (select x.id from app.credit_notes x
                where x.business_id = c.business_id and x.invoice_id = c.invoice_id
                  and x.status = 'issued' and x.deleted_at is null
                order by x.issued_at desc, x.id desc limit 1);

alter table app.credit_notes enable trigger guard_credit_note;

----------------------------------------------------------------------------------------------------
-- Function owners and grants
----------------------------------------------------------------------------------------------------

alter function app.keep_series_gapless() owner to postgres;
revoke all on function app.keep_series_gapless() from public, anon, authenticated;
grant execute on function app.keep_series_gapless() to bizcost_api;
