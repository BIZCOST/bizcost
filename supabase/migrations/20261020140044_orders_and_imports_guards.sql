-- BizCost: an order counts the sale of its own delivery, and an import's staged rows end with its
-- draft (M3 Step 10; D-330). supabase/tests/28_m3_immutability.test.sql found both: the guards let a
-- script, a later procedure or a bug write what the API never writes (D-205's and D-211's rule: no
-- path puts into the books what the API's checks keep out).
--
--   1. An order is delivered only with its own finalized sale: the sale its delivery posted (source
--      `order`, naming the order, posted). guard_order let an order become delivered naming any sale
--      of the business (another order's, a One sale, a reversed one), so a sale counted in two places
--      or none. And an order goes back to pending (Undo delivery) only once that sale is reversed:
--      guard_order let it go back while its sale stood, so the order was pending and its sale still
--      counted. The API reverses the sale before it puts the order back (orders.ts undoDelivery) and
--      posts the sale before it marks the order delivered (deliverOrder), so neither changes. An order
--      written already delivered is checked too (its own sale cannot exist before it: refused). A sale
--      of another business, or none, is left to the foreign key, which reports it.
--   2. An import's staged rows change only while the import is a draft: none is added to, or changed
--      in, a finalized or reversed import. Finalizing and discarding clear them (DELETE stays
--      allowed). Checked once per statement over its rows (an import sends 2,500 rows a call, D-260),
--      as the lines of a sale are (D-259).

----------------------------------------------------------------------------------------------------
-- 1. An order and the sale of its delivery
----------------------------------------------------------------------------------------------------

create function app.orders_keep_their_sale()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_source text;
  v_order_id uuid;
begin
  if new.status = 'delivered' then
    select s.status, s.source, s.order_id into v_status, v_source, v_order_id
    from app.sales s
    where s.business_id = new.business_id and s.id = new.sale_id and s.deleted_at is null;
    -- An unknown sale (or another business's) is left to the foreign key.
    if found and (v_status <> 'posted' or v_source <> 'order' or v_order_id is distinct from new.id) then
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

create trigger keep_sale before update on app.orders
  for each row
  when (old.status is distinct from new.status
        and (new.status = 'delivered' or old.status = 'delivered'))
  execute function app.orders_keep_their_sale();
create trigger keep_sale_insert before insert on app.orders
  for each row
  when (new.status = 'delivered')
  execute function app.orders_keep_their_sale();

----------------------------------------------------------------------------------------------------
-- 2. An import's staged rows, while it is a draft
----------------------------------------------------------------------------------------------------

create function app.guard_staged_rows()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_refused boolean;
begin
  -- EXECUTE plans each query for the statement's own number of rows (D-259); the imports are read
  -- once each, after their rows are reduced to one per import.
  if tg_op = 'INSERT' then
    execute $q$
      select exists (
        select 1
        from (select distinct r.business_id, r.import_id from new_rows r) r
        join app.sale_imports i on i.business_id = r.business_id and i.id = r.import_id
        where i.status <> 'draft'
      )$q$
      into v_refused;
  else
    execute $q$
      select exists (
        select 1
        from (select o.business_id, o.import_id from old_rows o
              union
              select n.business_id, n.import_id from new_rows n) r
        join app.sale_imports i on i.business_id = r.business_id and i.id = r.import_id
        where i.status <> 'draft'
      )$q$
      into v_refused;
  end if;
  if v_refused then
    raise exception 'the staged rows of a finalized import never change'
      using errcode = 'restrict_violation';
  end if;
  return null;
end
$$;

create trigger guard_staged_added after insert on app.sale_import_rows
  referencing new table as new_rows
  for each statement execute function app.guard_staged_rows();
create trigger guard_staged_changed after update on app.sale_import_rows
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.guard_staged_rows();

----------------------------------------------------------------------------------------------------
-- Function owners and grants
----------------------------------------------------------------------------------------------------

alter function app.orders_keep_their_sale() owner to postgres;
revoke all on function app.orders_keep_their_sale() from public, anon, authenticated;
grant execute on function app.orders_keep_their_sale() to bizcost_api;

alter function app.guard_staged_rows() owner to postgres;
revoke all on function app.guard_staged_rows() from public, anon, authenticated;
grant execute on function app.guard_staged_rows() to bizcost_api;
