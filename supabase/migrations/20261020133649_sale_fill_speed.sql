-- BizCost: a purchase that fills the costs of thousands of sale lines posts well within the statement
-- timeout (M3 Step 10; D-328). A purchase of the materials that three big sales wait for fills 21,600
-- material rows and 900 lines in one statement each (fillSaleMaterialCosts); the row guard of an
-- UPDATE (app.guard_posted_lines, BEFORE UPDATE FOR EACH ROW) read each row's sale under row level
-- security, whose membership check ran again for every row: 3.2 s of the 5.4 s of the material rows'
-- update, past the 15 s statement timeout once the machine was loaded.
--
-- A sale's lines and material rows are now checked once per UPDATE statement, AFTER UPDATE over the
-- rows it changed (the transition tables old_rows and new_rows), as an INSERT already is (D-259). The
-- rules, the refusals and their codes are those of the row guard, and nothing written changes:
--   - a row never moves to another sale (check_violation);
--   - a row of a posted or reversed sale takes only its fill-once values, each while it is still null
--     (D-222): a line's cost and its owner's time cost; a material row's unit cost, cost and basis,
--     together; touch_row's updated_at, updated_by and version change with them. Anything else fails
--     the whole statement (restrict_violation);
--   - a row of a draft sale changes freely; an unknown sale is left to the foreign key.
-- DELETE keeps the row guard (a row is never deleted: it refuses at the first row, and a statement
-- that deletes nothing is not refused). Purchase lines and return lines keep the row guard unchanged.

----------------------------------------------------------------------------------------------------
-- The UPDATE guard of a sale's lines and material rows, per statement
----------------------------------------------------------------------------------------------------

create function app.guard_posted_lines_changed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fill text[];
  v_kept text;
  v_moved boolean;
  v_refused boolean;
begin
  if tg_table_name = 'sale_lines' then
    v_fill := array['cost', 'time_cost', 'updated_at', 'updated_by', 'version'];
    v_kept := $k$
      (o.cost is null or n.cost is not distinct from o.cost)
      and (o.time_cost is null or n.time_cost is not distinct from o.time_cost)$k$;
  elsif tg_table_name = 'sale_line_materials' then
    v_fill := array['unit_cost', 'cost', 'basis', 'updated_at', 'updated_by', 'version'];
    v_kept := $k$
      (o.cost is null
        or (n.cost is not distinct from o.cost
          and n.unit_cost is not distinct from o.unit_cost
          and n.basis is not distinct from o.basis))$k$;
  else
    raise exception 'app.guard_posted_lines_changed() does not guard %.%', tg_table_schema, tg_table_name
      using errcode = 'feature_not_supported';
  end if;

  -- EXECUTE plans each query for the statement's own number of rows (D-259). A row's id never changes
  -- (touch_row), so its old and new rows pair by id. Each query aggregates over every row, never
  -- EXISTS: planned to stop at a first match, EXISTS paired the rows by a nested loop, 21,600 × 21,600
  -- comparisons when none matches.
  execute $q$
    select coalesce(pg_catalog.bool_or(n.sale_id is distinct from o.sale_id), false)
    from old_rows o
    join new_rows n on n.id = o.id$q$
    into v_moved;
  if v_moved then
    raise exception 'a sale line cannot move to another sale' using errcode = 'check_violation';
  end if;

  execute format($q$
    select coalesce(pg_catalog.bool_or(not (
             (pg_catalog.to_jsonb(o) - $1) = (pg_catalog.to_jsonb(n) - $1)
             and %s)), false)
    from old_rows o
    join new_rows n on n.id = o.id
    join app.sales s on s.business_id = n.business_id and s.id = n.sale_id
    where s.status <> 'draft'$q$, v_kept)
    into v_refused
    using v_fill;
  if v_refused then
    raise exception 'lines of a posted %.% are never changed', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return null;
end
$$;

drop trigger guard_posted on app.sale_lines;
create trigger guard_posted before delete on app.sale_lines
  for each row execute function app.guard_posted_lines();
create trigger guard_posted_changed after update on app.sale_lines
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.guard_posted_lines_changed();

drop trigger guard_posted on app.sale_line_materials;
create trigger guard_posted before delete on app.sale_line_materials
  for each row execute function app.guard_posted_lines();
create trigger guard_posted_changed after update on app.sale_line_materials
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.guard_posted_lines_changed();

----------------------------------------------------------------------------------------------------
-- Function owners and grants
----------------------------------------------------------------------------------------------------

alter function app.guard_posted_lines_changed() owner to postgres;
revoke all on function app.guard_posted_lines_changed() from public, anon, authenticated;
grant execute on function app.guard_posted_lines_changed() to bizcost_api;
