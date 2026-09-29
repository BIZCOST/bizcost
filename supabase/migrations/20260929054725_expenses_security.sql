-- BizCost: Expenses and Running Costs (M2 Step 5). Hand-written part of expenses_tables: row level
-- security and the touch and audit triggers of the four new tables; an expense that is frozen while
-- it is reviewed and never edited once posted; payments of what an expense left owed that are never
-- edited or deleted (as purchase_payments), and an expense that keeps them; receipts attached to a
-- live expense; the starter categories of the businesses that already exist; and the new permission
-- keys for the roles that businesses already have. See docs/DATA_MODEL.md §6 and DECISIONS.md
-- (D-164–D-170).
--
-- Rules as in purchasing_security: every tenant table gets ENABLE + FORCE RLS and the one standard
-- policy (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE;
-- functions have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE only
-- for bizcost_api.

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.cost_categories');
select app.apply_tenant_rls('app.expenses');
select app.apply_tenant_rls('app.expense_payments');
select app.apply_tenant_rls('app.running_costs');

create trigger touch_row before update on app.cost_categories
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.cost_categories
  for each row execute function app.audit_row();

create trigger touch_row before update on app.expenses
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.expenses
  for each row execute function app.audit_row();

create trigger touch_row before update on app.expense_payments
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.expense_payments
  for each row execute function app.audit_row();

create trigger touch_row before update on app.running_costs
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.running_costs
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- An expense under review is frozen; a posted expense is never edited (D-036, D-164)
----------------------------------------------------------------------------------------------------

-- The API follows the approval rules (expenseTransition in @bizcost/domain); this holds, for every
-- path, what the owner relies on: what was approved is what is posted, and a posted expense only
-- becomes reversed.
--   draft, rejected: may change (and be discarded: soft-deleted), but never become reversed or
--                    approved without being sent for approval first;
--   submitted, approved: only the review and posting columns change (approved, rejected, posted);
--                        an approved expense is never sent back to submitted; never discarded;
--   posted: only becomes reversed, with its reversal columns; reversed: never changes.
-- Nothing is ever deleted.
create function app.guard_expense()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_review text[] := array[
    'status', 'submitted_at', 'submitted_by', 'approved_at', 'approved_by', 'rejected_at',
    'rejected_by', 'rejection_reason', 'vat_in_cost', 'cost_total', 'posted_at', 'posted_by',
    'updated_at', 'updated_by', 'version'
  ];
  v_reversal text[] := array[
    'status', 'reversed_at', 'reversed_by', 'reversal_date', 'updated_at', 'updated_by', 'version'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'app.expenses rows are never deleted (a draft is discarded, a posted one reversed)'
      using errcode = 'restrict_violation';
  end if;
  if old.status in ('draft', 'rejected') then
    if new.status in ('approved', 'reversed') then
      raise exception 'an expense is approved only once sent for approval, reversed only once posted'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status in ('submitted', 'approved') then
    if new.status in ('submitted', 'approved', 'rejected', 'posted')
      and not (old.status = 'approved' and new.status = 'submitted')
      and (pg_catalog.to_jsonb(old) - v_review) = (pg_catalog.to_jsonb(new) - v_review)
    then
      return new;
    end if;
    raise exception 'an expense sent for approval is not changed: reject it first'
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'posted'
    and new.status = 'reversed'
    and (pg_catalog.to_jsonb(old) - v_reversal) = (pg_catalog.to_jsonb(new) - v_reversal)
  then
    return new;
  end if;
  raise exception 'a posted expense is never edited: reverse it instead'
    using errcode = 'restrict_violation';
end
$$;

create trigger guard_expense before update or delete on app.expenses
  for each row execute function app.guard_expense();

----------------------------------------------------------------------------------------------------
-- Payments of what an expense left owed (as purchase_payments, D-160)
----------------------------------------------------------------------------------------------------

-- A new payment names a posted expense bought on credit or paid by a member, and stands (not
-- reversed). Afterwards the only change is standing → reversed, with its reversal columns (touch_row
-- keeps updated_*/version). Nothing is deleted, soft or hard.
create function app.guard_expense_payment()
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
    raise exception 'app.expense_payments rows are never deleted (a payment is reversed)'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    select e.status, e.payment_method into v_status, v_method
    from app.expenses e
    where e.business_id = new.business_id and e.id = new.expense_id and e.deleted_at is null;
    -- An unknown expense is left to the foreign key (it reports the right error).
    if found and (v_status <> 'posted' or v_method not in ('supplier_credit', 'paid_by_member')) then
      raise exception 'a payment is recorded only on a posted expense bought on credit or paid by a member'
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

create trigger guard_payment before insert or update or delete on app.expense_payments
  for each row execute function app.guard_expense_payment();

-- An expense with payments that stand is not reversed (the API says EXPENSE_HAS_PAYMENTS first).
create function app.expenses_keep_payments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from app.expense_payments ep
    where ep.business_id = new.business_id
      and ep.expense_id = new.id
      and ep.reversed_at is null
      and ep.deleted_at is null
  ) then
    raise exception 'an expense with payments is reversed only once its payments are'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_payments before update on app.expenses
  for each row
  when (old.status = 'posted' and new.status = 'reversed')
  execute function app.expenses_keep_payments();

----------------------------------------------------------------------------------------------------
-- Attachments name a live record: a purchase or an expense (D-139, D-145)
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
  if tg_op = 'INSERT' then
    -- FOR SHARE: a discard (FOR UPDATE, then the receipts it sees) cannot run between this check
    -- and the commit of the new row.
    if new.entity = 'purchase' then
      perform 1 from app.purchases p
      where p.business_id = new.business_id and p.id = new.entity_id and p.deleted_at is null
      for share;
    elsif new.entity = 'expense' then
      perform 1 from app.expenses e
      where e.business_id = new.business_id and e.id = new.entity_id and e.deleted_at is null
      for share;
    else
      raise exception 'attachment entity % is unknown', new.entity using errcode = 'check_violation';
    end if;
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
-- The starter categories of the businesses that already exist (D-116, D-167)
----------------------------------------------------------------------------------------------------

-- New businesses get them from Smart Setup (business.createFromSetup), named in the business's
-- language by the i18n keys setup.cost_categories.<key>; the names below must equal those keys
-- (an API unit test compares them). A business that already has categories is left as it is.
with starters (key, en, ar) as (
  values
    ('rent', 'Rent', 'الإيجار'),
    ('electricity', 'Electricity', 'الكهرباء'),
    ('water', 'Water', 'الماء'),
    ('salaries', 'Salaries', 'الرواتب'),
    ('internet', 'Internet', 'الإنترنت'),
    ('phone', 'Phone', 'الهاتف'),
    ('licences', 'Licences', 'الرخص'),
    ('insurance', 'Insurance', 'التأمين'),
    ('software', 'Software subscriptions', 'اشتراكات البرامج'),
    ('vehicles', 'Vehicle costs', 'تكاليف المركبات'),
    ('marketing', 'Marketing', 'التسويق'),
    ('equipment', 'Equipment costs', 'تكاليف المعدات'),
    ('maintenance', 'Maintenance', 'الصيانة'),
    ('other', 'Other', 'أخرى')
)
insert into app.cost_categories (id, business_id, name, created_by)
select app.uuid_v7(), b.id, case b.default_locale when 'ar' then s.ar else s.en end, b.created_by
from app.businesses b
cross join starters s
where b.deleted_at is null
  and not exists (select 1 from app.cost_categories c where c.business_id = b.id);

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (as purchasing_security did for M2 Step 3)
----------------------------------------------------------------------------------------------------

-- Expenses and Running Costs declare their permission keys now (they stay unreleased until M2 Step
-- 7). The pairs below must equal the new keys of role-templates.ts in @bizcost/modules (PRODUCT.md
-- §8, D-168). Members holding a changed role get a new permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'expenses.documents.view'),
    ('admin', 'expenses.documents.manage'),
    ('admin', 'expenses.documents.approve'),
    ('admin', 'expenses.documents.post'),
    ('admin', 'expenses.documents.reverse'),
    ('admin', 'expenses.payments.view'),
    ('admin', 'expenses.payments.record'),
    ('admin', 'expenses.approval.manage'),
    ('admin', 'running_costs.items.view'),
    ('admin', 'running_costs.items.manage'),
    ('manager', 'expenses.documents.view'),
    ('manager', 'expenses.documents.manage'),
    ('manager', 'expenses.documents.approve'),
    ('manager', 'expenses.documents.post'),
    ('manager', 'expenses.documents.reverse'),
    ('manager', 'expenses.payments.view'),
    ('manager', 'expenses.payments.record'),
    ('manager', 'running_costs.items.view'),
    ('manager', 'running_costs.items.manage'),
    ('accountant', 'expenses.documents.view'),
    ('accountant', 'running_costs.items.view')
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

alter function app.guard_expense() owner to postgres;
alter function app.guard_expense_payment() owner to postgres;
alter function app.expenses_keep_payments() owner to postgres;
alter function app.check_attachment_target() owner to postgres;

revoke all on function app.guard_expense() from public, anon, authenticated;
revoke all on function app.guard_expense_payment() from public, anon, authenticated;
revoke all on function app.expenses_keep_payments() from public, anon, authenticated;
revoke all on function app.check_attachment_target() from public, anon, authenticated;
grant execute on function app.guard_expense() to bizcost_api;
grant execute on function app.guard_expense_payment() to bizcost_api;
grant execute on function app.expenses_keep_payments() to bizcost_api;
grant execute on function app.check_attachment_target() to bizcost_api;
