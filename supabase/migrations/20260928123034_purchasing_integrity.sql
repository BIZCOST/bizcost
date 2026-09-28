-- BizCost: M2 Step 3 security review (D-145). Two rules of Step 3 that a concurrent request could get
-- round, now also held by the database:
--   1. a material keeps its kind of measure once its goods are in the stock ledger (D-134): the trigger
--      keep_dimension runs with the material's row locked, so a posting that committed while the
--      change waited for the row is seen, and the change is refused (SQLSTATE BZ423, which the API
--      answers with `material_in_use`). The API checks drafts too (D-134), under the same row lock;
--   2. a receipt is attached only to a live record (D-139): check_target refuses a discarded purchase,
--      and locks it FOR SHARE, so a discard in flight (which locks the purchase FOR UPDATE and then takes
--      the receipts it sees) either finishes first or waits for the attachment and takes it too.
-- Functions as in purchasing_security: SET search_path = '' with schema-qualified names, owner postgres,
-- EXECUTE revoked from PUBLIC/anon/authenticated (trigger functions run as the trigger fires).

----------------------------------------------------------------------------------------------------
-- A material in the ledger keeps its dimension
----------------------------------------------------------------------------------------------------

create function app.materials_keep_dimension()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A fresh snapshot (READ COMMITTED, a volatile function) taken after the row lock: movements
  -- committed while this update waited for the row are counted.
  if exists (
    select 1 from app.stock_movements m
    where m.business_id = new.business_id and m.material_id = new.id
  ) then
    raise exception 'material % is in the stock ledger: its kind of measure cannot change', new.id
      using errcode = 'BZ423';
  end if;
  return new;
end
$$;

create trigger keep_dimension before update of dimension on app.materials
  for each row when (new.dimension is distinct from old.dimension)
  execute function app.materials_keep_dimension();

----------------------------------------------------------------------------------------------------
-- Attachments name a live record
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
  if tg_op = 'INSERT' and new.entity = 'purchase' then
    -- FOR SHARE: a discard (FOR UPDATE, then the receipts it sees) cannot run between this check
    -- and the commit of the new row.
    perform 1 from app.purchases p
    where p.business_id = new.business_id and p.id = new.entity_id and p.deleted_at is null
    for share;
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
-- Ownership and grants
----------------------------------------------------------------------------------------------------

alter function app.materials_keep_dimension() owner to postgres;
alter function app.check_attachment_target() owner to postgres;

revoke all on function app.materials_keep_dimension() from public, anon, authenticated;
revoke all on function app.check_attachment_target() from public, anon, authenticated;
grant execute on function app.materials_keep_dimension() to bizcost_api;
grant execute on function app.check_attachment_target() to bizcost_api;
