-- BizCost: the database guards of M4 Step 2's review (stock counts). Hand-written. Rules as in
-- tenancy_security (search_path, owner, grants). supabase/tests/32_stock_counts_review.test.sql found
-- each as a failing check (D-205's and D-211's rule: no path puts into the books what the API's checks
-- keep out).
--
--   1. A material is never written already tracked: materials_keep_tracking checked an update only, so
--      an insert could name any day, with no first count.
--   2. A count keeps its kind, branch and day from the start, whatever its status: guard_count_lines
--      checks a line against its count when the line is written, so a draft moved to another branch,
--      another day or kind would leave its lines, and the API's day-order checks, behind.
--   3. A count's ledger rows (`opening`, `count`, and their reversals) stand only for a count that is
--      finalized when the transaction commits: posted (or reversed since) for its own rows, reversed
--      for a reversal row, the count and the line live. Finalizing writes them while the count is still
--      a draft (its lines take what was found first, check_count_movement), so the check is deferred to
--      the commit. A count with ledger rows is never discarded: its rows would stay in the ledger.
--   4. A material is tracked only while a first count of it stands, from that count's day: a first
--      count that stops standing (reversed, or discarded) is checked at the commit (the API marks the
--      count reversed, then stops tracking its materials, in one transaction); setting a material's
--      tracking is checked when it is written (materials_keep_tracking).

----------------------------------------------------------------------------------------------------
-- 1. A material is never written already tracked
----------------------------------------------------------------------------------------------------

-- As stock_counts_security, and an insert never names a day: no first count can have a line of a
-- material that does not exist yet.
create or replace function app.materials_keep_tracking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    raise exception 'material % is tracked only from a finalized first count of it', new.id
      using errcode = 'check_violation';
  end if;
  if new.stock_tracked_from is not null then
    if old.stock_tracked_from is not null or not exists (
      select 1
      from app.stock_counts c
      join app.stock_count_lines l
        on l.business_id = c.business_id and l.count_id = c.id and l.deleted_at is null
      where c.business_id = new.business_id
        and c.kind = 'opening'
        and c.status = 'posted'
        and c.deleted_at is null
        and c.business_date = new.stock_tracked_from
        and l.material_id = new.id
    ) then
      raise exception 'material % is tracked from the day of its first count, once', new.id
        using errcode = 'check_violation';
    end if;
  elsif exists (
    select 1
    from app.stock_counts c
    join app.stock_count_lines l
      on l.business_id = c.business_id and l.count_id = c.id and l.deleted_at is null
    where c.business_id = new.business_id
      and c.kind = 'opening'
      and c.status = 'posted'
      and c.deleted_at is null
      and l.material_id = new.id
  ) then
    raise exception 'material % is tracked while its first count stands', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_tracking_on_insert before insert on app.materials
  for each row when (new.stock_tracked_from is not null)
  execute function app.materials_keep_tracking();

----------------------------------------------------------------------------------------------------
-- 2 and 3. A count keeps its kind, branch and day; one with ledger rows is never discarded
----------------------------------------------------------------------------------------------------

create function app.guard_count_head()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind
    or new.location_id is distinct from old.location_id
    or new.business_date is distinct from old.business_date
  then
    raise exception 'a count keeps its kind, branch and day' using errcode = 'check_violation';
  end if;
  -- Its live lines (a line taken off with a ledger row is refused at commit, count_finalized).
  if old.deleted_at is null and new.deleted_at is not null and exists (
    select 1
    from app.stock_count_lines l
    join app.stock_movements m
      on m.business_id = l.business_id and m.count_line_id = l.id and m.kind in ('opening', 'count')
    where l.business_id = new.business_id and l.count_id = new.id and l.deleted_at is null
  ) then
    raise exception 'a count with rows in the ledger is never discarded'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger guard_head before update on app.stock_counts
  for each row
  when (new.kind is distinct from old.kind
        or new.location_id is distinct from old.location_id
        or new.business_date is distinct from old.business_date
        or (old.deleted_at is null and new.deleted_at is not null))
  execute function app.guard_count_head();

----------------------------------------------------------------------------------------------------
-- 3. A count's ledger rows stand only for a finalized count (at commit)
----------------------------------------------------------------------------------------------------

create function app.count_movement_finalized()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_count_live boolean;
  v_line_live boolean;
begin
  select c.status, c.deleted_at is null, l.deleted_at is null
    into v_status, v_count_live, v_line_live
  from app.stock_count_lines l
  join app.stock_counts c on c.business_id = l.business_id and c.id = l.count_id
  where l.business_id = new.business_id and l.id = new.count_line_id;
  -- An unknown line is left to the foreign key.
  if not found then
    return null;
  end if;
  if not v_count_live or not v_line_live
    or (new.kind = 'reversal' and v_status <> 'reversed')
    or (new.kind <> 'reversal' and v_status not in ('posted', 'reversed'))
  then
    raise exception 'a count''s % row stands only for a finalized count', new.kind
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger count_finalized
  after insert on app.stock_movements
  deferrable initially deferred
  for each row
  when (new.count_line_id is not null)
  execute function app.count_movement_finalized();

----------------------------------------------------------------------------------------------------
-- 4. A first count that no longer stands leaves no material tracked from it (at commit)
----------------------------------------------------------------------------------------------------

-- Each material on the count's lines that is tracked has a first count that stands, with a line of
-- it, on the day it is tracked from.
create function app.count_keeps_tracking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from app.stock_count_lines l
    join app.materials m on m.business_id = l.business_id and m.id = l.material_id
    where l.business_id = new.business_id
      and l.count_id = new.id
      and l.deleted_at is null
      and m.stock_tracked_from is not null
      and not exists (
        select 1
        from app.stock_counts c
        join app.stock_count_lines cl
          on cl.business_id = c.business_id and cl.count_id = c.id and cl.deleted_at is null
        where c.business_id = m.business_id
          and c.kind = 'opening'
          and c.status = 'posted'
          and c.deleted_at is null
          and c.business_date = m.stock_tracked_from
          and cl.material_id = m.id
      )
  ) then
    raise exception 'a material is tracked only while its first count stands'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger keep_tracking
  after update of status, deleted_at on app.stock_counts
  deferrable initially deferred
  for each row
  when (new.kind = 'opening'
        and (new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at))
  execute function app.count_keeps_tracking();

----------------------------------------------------------------------------------------------------
-- Function owners and grants
----------------------------------------------------------------------------------------------------

alter function app.materials_keep_tracking() owner to postgres;
alter function app.guard_count_head() owner to postgres;
alter function app.count_movement_finalized() owner to postgres;
alter function app.count_keeps_tracking() owner to postgres;

revoke all on function app.materials_keep_tracking() from public, anon, authenticated;
revoke all on function app.guard_count_head() from public, anon, authenticated;
revoke all on function app.count_movement_finalized() from public, anon, authenticated;
revoke all on function app.count_keeps_tracking() from public, anon, authenticated;
grant execute on function app.materials_keep_tracking() to bizcost_api;
grant execute on function app.guard_count_head() to bizcost_api;
grant execute on function app.count_movement_finalized() to bizcost_api;
grant execute on function app.count_keeps_tracking() to bizcost_api;
