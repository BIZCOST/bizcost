-- BizCost: what a purchase leaves owed, and its payments (the owner's requests of 2026-09-29).
-- Hand-written part of purchasing_payments_tables: row level security and the touch and audit
-- triggers of purchase_payments, payments that are never edited or deleted (a payment recorded by
-- mistake is reversed), a purchase that keeps its payments (it is reversed only once they are), and
-- the new permission keys for the roles that businesses already have. Rules as in
-- purchasing_security: functions have SET search_path = '' with schema-qualified names, owner
-- postgres, and EXECUTE only for bizcost_api.

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.purchase_payments');

create trigger touch_row before update on app.purchase_payments
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.purchase_payments
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- A payment is recorded on a final purchase that is owed, and is never edited: only reversed
----------------------------------------------------------------------------------------------------

-- The API checks the same (DOCUMENT_NOT_POSTED, VALIDATION); this holds it for every path. A new
-- payment names a posted purchase bought on credit or paid by a member, and stands (not reversed).
-- Afterwards the only change is standing → reversed, with its reversal columns (touch_row keeps
-- updated_*/version). Nothing is deleted, soft or hard.
create function app.guard_purchase_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reversal text[] := array[
    'reversed_at', 'reversed_by', 'reversal_date', 'updated_at', 'updated_by', 'version'
  ];
  v_status text;
  v_method text;
begin
  if tg_op = 'DELETE' then
    raise exception 'app.purchase_payments rows are never deleted (a payment is reversed)'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    select p.status, p.payment_method into v_status, v_method
    from app.purchases p
    where p.business_id = new.business_id and p.id = new.purchase_id and p.deleted_at is null;
    -- An unknown purchase is left to the foreign key (it reports the right error).
    if found and (v_status <> 'posted' or v_method is null
      or v_method not in ('supplier_credit', 'paid_by_member'))
    then
      raise exception 'a payment is recorded only on a posted purchase bought on credit or paid by a member'
        using errcode = 'check_violation';
    end if;
    if new.reversed_at is not null or new.deleted_at is not null then
      raise exception 'a new payment stands' using errcode = 'check_violation';
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

create trigger guard_payment before insert or update or delete on app.purchase_payments
  for each row execute function app.guard_purchase_payment();

-- A purchase with payments that stand is not reversed (the API says PURCHASE_HAS_PAYMENTS first).
create function app.purchases_keep_payments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from app.purchase_payments pp
    where pp.business_id = new.business_id
      and pp.purchase_id = new.id
      and pp.reversed_at is null
      and pp.deleted_at is null
  ) then
    raise exception 'a purchase with payments is reversed only once its payments are'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_payments before update on app.purchases
  for each row
  when (old.status = 'posted' and new.status = 'reversed')
  execute function app.purchases_keep_payments();

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (as purchasing_security did for M2 Step 3)
----------------------------------------------------------------------------------------------------

-- "See amounts owed" and "Record payments of amounts owed" (purchases.payments.view / .record) for
-- the Admin and Manager templates (the Owner holds every key). The pairs below must equal the new keys
-- of role-templates.ts in @bizcost/modules. Members holding a changed role get a new
-- permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'purchases.payments.view'),
    ('admin', 'purchases.payments.record'),
    ('manager', 'purchases.payments.view'),
    ('manager', 'purchases.payments.record')
),
added as (
  insert into app.role_permissions (id, business_id, role_id, permission_key, created_by)
  select app.uuid_v7(), r.business_id, r.id, d.permission_key, r.created_by
  from app.roles r
  join defaults d on d.template_key = r.template_key
  where r.deleted_at is null
  on conflict (business_id, role_id, permission_key) do nothing
  returning business_id, role_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and (m.business_id, m.role_id) in (select a.business_id, a.role_id from added a);

----------------------------------------------------------------------------------------------------
-- Function owners and grants
----------------------------------------------------------------------------------------------------

alter function app.guard_purchase_payment() owner to postgres;
alter function app.purchases_keep_payments() owner to postgres;

revoke all on function app.guard_purchase_payment() from public, anon, authenticated;
revoke all on function app.purchases_keep_payments() from public, anon, authenticated;
grant execute on function app.guard_purchase_payment() to bizcost_api;
grant execute on function app.purchases_keep_payments() to bizcost_api;
