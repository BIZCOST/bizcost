-- BizCost: real profit switched on (M3 Step 3). Hand-written part: what an expense pays may now name a
-- sales channel (expense_channel_fees), so the expense guard lets `channel_id` change with `pays`; and
-- Reports declares its permission keys (it stays unreleased until Release A, M3 Step 6) with the roles
-- businesses already have given them. See docs/DECISIONS.md (M3 Step 3, from D-237).

----------------------------------------------------------------------------------------------------
-- What an expense pays, with the review (D-216; M3 Step 3)
----------------------------------------------------------------------------------------------------

-- As in expense_running_cost: what an expense pays changes freely on a draft and, with the review and
-- posting columns, while it is submitted or approved (the one who approves or finalizes may say it);
-- a posted expense keeps it and only becomes reversed. `channel_id` (the channel whose app fees it
-- pays) goes with `pays`, as `running_cost_id` does.
create or replace function app.guard_expense()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_review text[] := array[
    'status', 'submitted_at', 'submitted_by', 'approved_at', 'approved_by', 'rejected_at',
    'rejected_by', 'rejection_reason', 'vat_in_cost', 'cost_total', 'posted_at', 'posted_by',
    'pays', 'running_cost_id', 'channel_id', 'updated_at', 'updated_by', 'version'
  ];
  v_reversal text[] := array[
    'status', 'reversed_at', 'reversed_by', 'reversal_date', 'reversal_period_month',
    'updated_at', 'updated_by', 'version'
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

alter function app.guard_expense() owner to postgres;
revoke all on function app.guard_expense() from public, anon, authenticated;
grant execute on function app.guard_expense() to bizcost_api;

----------------------------------------------------------------------------------------------------
-- Reports' permission keys for the roles that exist
----------------------------------------------------------------------------------------------------

-- Reports declares its permission keys now (M3 Step 3; released in Step 6). The pairs below must
-- equal the new keys of role-templates.ts in @bizcost/modules (the plan's Q10 table, D-218):
-- `reports.sales.view` (Reports → Real profit with its sales figures: Manager, Accountant, Sales,
-- Supervisor) and `reports.profit.view` (its profit and costs, Q11: Manager and Accountant). Admin
-- holds every key; the Employee gets neither. Members holding a changed role get a new
-- permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'reports.sales.view'),
    ('admin', 'reports.profit.view'),
    ('manager', 'reports.sales.view'),
    ('manager', 'reports.profit.view'),
    ('accountant', 'reports.sales.view'),
    ('accountant', 'reports.profit.view'),
    ('sales', 'reports.sales.view'),
    ('supervisor', 'reports.sales.view')
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
