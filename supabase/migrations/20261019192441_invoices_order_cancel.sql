-- BizCost: an order its invoices billed is cancelled once they are fully credited (M3 Step 8,
-- DECISIONS.md D-305). Hand-written. Replaces invoices_security's orders_keep_invoices: an order an
-- issued invoice refers to still keeps its delivery (Undo delivery is refused while any issued invoice
-- refers to it: its credit notes took back its sale's lines), but a pending order is cancelled once
-- every issued invoice of it is credited in full (a job cancelled after its deposit invoice: the
-- deposit invoice is credited, the money given back on it, then the order is cancelled). A credit note
-- of a pending order's invoice posts no sale (its delivery has counted nothing), so nothing in the
-- books changes with the cancellation. Rules as in tenancy_security (search_path, owner, grants).

create or replace function app.orders_keep_invoices()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'delivered' and new.status = 'pending' then
    if exists (
      select 1 from app.invoices i
       where i.business_id = new.business_id and i.order_id = new.id
         and i.status = 'issued' and i.deleted_at is null
    ) then
      raise exception 'an order an issued invoice refers to keeps its delivery'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- pending → cancelled: only once each issued invoice of it is fully credited.
  if exists (
    select 1 from app.invoices i
     where i.business_id = new.business_id and i.order_id = new.id
       and i.status = 'issued' and i.deleted_at is null
       and i.total > coalesce((
         select sum(c.total) from app.credit_notes c
          where c.business_id = i.business_id and c.invoice_id = i.id
            and c.status = 'issued' and c.deleted_at is null), 0)
  ) then
    raise exception 'an order is cancelled only once its issued invoices are fully credited'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

alter function app.orders_keep_invoices() owner to postgres;
revoke all on function app.orders_keep_invoices() from public, anon, authenticated;
grant execute on function app.orders_keep_invoices() to bizcost_api;
