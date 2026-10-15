-- BizCost: "Undo delivery" keeps what the delivery cost (M3 Step 5 review fixes; D-273). A delivered
-- order shows its sale's delivery cost, which may be filled once later when it was not known when the
-- order was entered (sale.fillDeliveryCost, D-230). Undoing the delivery reverses that sale and puts
-- the order back to pending, which cleared only its delivery columns: the cost filled on the sale was
-- lost, and the order delivered again had none. Now a delivered order going back to pending may also
-- take its sale's delivery cost, only when it had none of its own (nothing else changes; the order's
-- own cost is never replaced).

create or replace function app.guard_order()
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
    if new.status = 'pending'
      and (v_old - v_delivery - 'delivery_cost') = (v_new - v_delivery - 'delivery_cost')
      and (
        new.delivery_cost is not distinct from old.delivery_cost
        or (
          old.delivery_cost is null
          and new.delivery_cost = (
            select s.delivery_cost from app.sales s
             where s.business_id = old.business_id and s.id = old.sale_id
          )
        )
      )
    then
      return new;
    end if;
  end if;
  raise exception 'a delivered or cancelled order is never edited (undo the delivery first)'
    using errcode = 'restrict_violation';
end
$$;
