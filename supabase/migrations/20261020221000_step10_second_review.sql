-- BizCost: the database fixes of the second review of M3 Step 10's closing fixes (DECISIONS.md D-338).
-- Hand-written. Rules as in tenancy_security (search_path, owner, grants).
--
--   1. The printed number of an invoice or a credit note follows its place in the series (D-335 kept
--      only seq without a gap): at issue (written already issued, or by the update that issues it), its
--      number is its series counter's prefix and its seq padded with zeros to the counter's padding,
--      as takeNumber formats it (documentNumber of @bizcost/domain; no counter yet: the series'
--      defaults, INV- and CN- with 4 digits). Before, any text passed: INV-0003 printed on the second
--      invoice of a series (the gap the UAE rules forbid, on paper) and CN-0007 on the first credit
--      note. A prefix edited later still renumbers nothing: the issued number is never changed.
--      supabase/tests/30_m3_step10_review.test.sql §4 found it as a failing test.
--   2. The line guard of an update (D-328) takes one pass over the statement's rows instead of two,
--      and compares each row's other columns by name (read from the catalog for the table, so a column
--      added later is guarded too) instead of building both rows as jsonb: the same rules, refusals and
--      codes, in about half the time (a fill of 21,600 waiting rows spends it 22 times, D-336).

----------------------------------------------------------------------------------------------------
-- 1. An issued number is the series' own
----------------------------------------------------------------------------------------------------

-- As step10_review_guards (an issue takes its series' first number, or the one after a number issued),
-- and the number it prints is that seq as the counter prints it.
create or replace function app.keep_series_gapless()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_series text := case tg_table_name when 'invoices' then 'invoice' else 'credit_note' end;
  v_first int;
  v_prefix text;
  v_padding int;
  v_below boolean;
  v_before boolean;
begin
  select c.first_no, c.prefix, c.padding into v_first, v_prefix, v_padding
  from app.document_counters c
  where c.business_id = new.business_id and c.series = v_series and c.deleted_at is null;
  if not found then
    -- DOCUMENT_COUNTER_DEFAULTS of @bizcost/domain (takeNumber makes the counter with them).
    v_first := 1;
    v_prefix := case v_series when 'invoice' then 'INV-' else 'CN-' end;
    v_padding := 4;
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
  -- documentNumber: the prefix, then seq padded with zeros (never cut) to the padding.
  if new.number is distinct from v_prefix || pg_catalog.lpad(
       new.seq::text, greatest(v_padding, pg_catalog.length(new.seq::text)), '0') then
    raise exception 'an invoice or credit note prints the number of its place in the series'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

----------------------------------------------------------------------------------------------------
-- 2. The line guard of an update, in one pass
----------------------------------------------------------------------------------------------------

-- As sale_fill_speed (D-328): a row never moves to another sale (check_violation); a row of a posted
-- or reversed sale takes only its fill-once values, each while still null, with touch_row's columns
-- (restrict_violation); a draft's rows change freely.
create or replace function app.guard_posted_lines_changed()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_fill text[];
  v_kept text;
  v_same text;
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
  -- Every other column of the table, now (a column added later is compared too).
  select pg_catalog.string_agg(
           pg_catalog.format('o.%1$I is not distinct from n.%1$I', a.attname), ' and '
           order by a.attnum)
    into v_same
    from pg_catalog.pg_attribute a
   where a.attrelid = tg_relid and a.attnum > 0 and not a.attisdropped
     and a.attname <> all (v_fill);

  -- EXECUTE plans the query for the statement's own number of rows (D-259). A row's id never changes
  -- (touch_row), so its old and new rows pair by id. It aggregates over every row, never EXISTS
  -- (planned to stop at a first match, EXISTS paired the rows by a nested loop, D-328).
  execute pg_catalog.format($q$
    select coalesce(pg_catalog.bool_or(n.sale_id is distinct from o.sale_id), false),
           coalesce(pg_catalog.bool_or(s.status <> 'draft' and not (%s and %s)), false)
    from old_rows o
    join new_rows n on n.id = o.id
    left join app.sales s on s.business_id = n.business_id and s.id = n.sale_id$q$, v_same, v_kept)
    into v_moved, v_refused;
  if v_moved then
    raise exception 'a sale line cannot move to another sale' using errcode = 'check_violation';
  end if;
  if v_refused then
    raise exception 'lines of a posted %.% are never changed', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return null;
end
$function$;
