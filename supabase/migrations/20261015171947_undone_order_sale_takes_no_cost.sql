-- BizCost: an order's sale whose delivery was undone takes no delivery cost (M3 Step 5 review fixes;
-- D-273). A sale's delivery cost is filled once while it is missing, on a posted or a reversed sale
-- (D-230). An order's sale is reversed only by Undo delivery, which takes the cost filled on it back
-- onto the order (order_undo_keeps_delivery_cost); a cost filled on that reversed sale afterwards (or
-- by a fill that waited on the sale's row while the undo committed) landed on a sale that counts
-- nowhere, and the order, delivered again, had none. Now a reversed sale of an order never takes one:
-- its order holds what the delivery cost and is changed instead. Everything else is as in
-- sales_security (purchases, returns, credit notes, statements, imports and other sales unchanged).

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
  -- The fill-once of a sale's delivery cost, but never on an order's reversed sale (read from the
  -- row's JSON: the other tables have no order_id).
  if tg_table_name = 'sales'
    and new.status = old.status
    and v_old -> 'delivery_cost' = 'null'::jsonb
    and v_new -> 'delivery_cost' <> 'null'::jsonb
    and (v_old - v_fill) = (v_new - v_fill)
    and not (old.status = 'reversed' and v_old ->> 'order_id' is not null)
  then
    return new;
  end if;
  raise exception 'a posted %.% is never edited: reverse it instead', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;
