-- BizCost: Invoices, credit notes, payments on invoices and customer statements (M3 Step 8). Hand-written
-- part of the invoices tables: row level security and the touch and audit triggers; an invoice and a
-- credit note change freely while drafts and are frozen once issued (only their stored PDF may be
-- linked once), their lines changed only while their document is a draft; customer payments on an
-- issued invoice (and none on an order or sale that has one: its payments count toward its invoices);
-- a sale that keeps its invoice (an invoice's or credit note's sale is never reversed, a sale or an
-- order's delivery an issued invoice refers to is not reversed, an order an issued invoice refers to is
-- not cancelled); invoices' files and an invoice line's picture; and the new keys for the roles that
-- businesses already have. See docs/DATA_MODEL.md §6 and DECISIONS.md (M3 Step 8, from D-301).
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE; functions
-- have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE revoked from
-- PUBLIC/anon/authenticated (trigger functions run as the trigger fires).

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.invoices');
select app.apply_tenant_rls('app.invoice_lines');
select app.apply_tenant_rls('app.credit_notes');
select app.apply_tenant_rls('app.credit_note_lines');

create trigger touch_row before update on app.invoices
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.invoices
  for each row execute function app.audit_row();

create trigger touch_row before update on app.invoice_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.invoice_lines
  for each row execute function app.audit_row();

create trigger touch_row before update on app.credit_notes
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.credit_notes
  for each row execute function app.audit_row();

create trigger touch_row before update on app.credit_note_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.credit_note_lines
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- Issued documents are frozen (VAT ER Arts 59, 60: only a credit note corrects an invoice)
----------------------------------------------------------------------------------------------------

-- An invoice or a credit note changes freely while a draft (it has no number), is issued (its number,
-- dates, kind, snapshots and amounts are written with it, all at once) or discarded (soft deleted; a
-- discarded draft never changes again). Once issued it is never edited, reversed or deleted: the only
-- change is its stored PDF, linked once. Rows are never deleted, hard or soft, but a draft.
create function app.guard_issued_document()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_meta text[] := array['updated_at', 'updated_by', 'version'];
  v_pdf text[] := array['pdf_upload_id', 'updated_at', 'updated_by', 'version'];
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception '%.% rows are never deleted (a draft is discarded)', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  v_old := pg_catalog.to_jsonb(old);
  v_new := pg_catalog.to_jsonb(new);
  if old.status = 'draft' then
    if old.deleted_at is not null then
      raise exception 'a discarded draft never changes' using errcode = 'restrict_violation';
    end if;
    if new.status = 'issued' and new.deleted_at is not null then
      raise exception 'an issued document is never discarded' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (v_old - v_meta) = (v_new - v_meta) then
    return new;
  end if;
  if old.pdf_upload_id is null and new.pdf_upload_id is not null
    and (v_old - v_pdf) = (v_new - v_pdf)
  then
    return new;
  end if;
  raise exception 'an issued document is never edited (issue a credit note instead)'
    using errcode = 'restrict_violation';
end
$$;

create trigger guard_invoice before update or delete on app.invoices
  for each row execute function app.guard_issued_document();
create trigger guard_credit_note before update or delete on app.credit_notes
  for each row execute function app.guard_issued_document();

-- A document's lines change only while it is a live draft (taken out: soft-deleted); never deleted,
-- never moved to another document.
create function app.guard_document_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_discarded boolean;
begin
  if tg_op = 'DELETE' then
    raise exception '%.% rows are never deleted', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  if tg_table_name = 'invoice_lines' then
    if tg_op = 'UPDATE' and old.invoice_id is distinct from new.invoice_id then
      raise exception 'an invoice line cannot move to another invoice' using errcode = 'check_violation';
    end if;
    select i.status, i.deleted_at is not null into v_status, v_discarded
    from app.invoices i
    where i.business_id = new.business_id and i.id = new.invoice_id;
  else
    if tg_op = 'UPDATE' and old.credit_note_id is distinct from new.credit_note_id then
      raise exception 'a credit note line cannot move to another credit note'
        using errcode = 'check_violation';
    end if;
    select c.status, c.deleted_at is not null into v_status, v_discarded
    from app.credit_notes c
    where c.business_id = new.business_id and c.id = new.credit_note_id;
  end if;
  -- An unknown document is left to the foreign key (it reports the right error).
  if v_status is not null and (v_status <> 'draft' or v_discarded) then
    raise exception 'the lines of an issued document are never changed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger guard_invoice_lines before insert or update or delete on app.invoice_lines
  for each row execute function app.guard_document_lines();
create trigger guard_credit_note_lines before insert or update or delete on app.credit_note_lines
  for each row execute function app.guard_document_lines();

----------------------------------------------------------------------------------------------------
-- Customer payments: on an issued invoice; an order or sale with one pays through it (A2)
----------------------------------------------------------------------------------------------------

-- As orders_security, with invoices: a payment on a live issued invoice (money given back too). Once an
-- order or a sale has an issued invoice, what is owed lives on its invoices: a new payment towards it
-- is recorded on them (money given back on the order or sale itself is still allowed: it was paid
-- there). Afterwards the only change is standing → reversed, with its reversal columns.
create or replace function app.guard_customer_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reversal text[] := array[
    'reversed_at', 'reversed_by', 'reversal_date', 'updated_at', 'updated_by', 'version'
  ];
  v_status text;
  v_source text;
  v_pay_later boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'app.customer_payments rows are never deleted (a payment is reversed)'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.reversed_at is not null or new.deleted_at is not null then
      raise exception 'a new payment stands' using errcode = 'check_violation';
    end if;
    if new.invoice_id is not null then
      select i.status into v_status
      from app.invoices i
      where i.business_id = new.business_id and i.id = new.invoice_id and i.deleted_at is null;
      -- An unknown invoice is left to the foreign key.
      if found and v_status <> 'issued' then
        raise exception 'a payment is recorded only on an issued invoice'
          using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if new.kind = 'payment' and exists (
      select 1 from app.invoices i
       where i.business_id = new.business_id and i.status = 'issued' and i.deleted_at is null
         and (i.order_id = new.order_id or i.sale_id = new.sale_id)
    ) then
      raise exception 'an invoiced order or sale is paid through its invoices'
        using errcode = 'check_violation';
    end if;
    if new.order_id is not null then
      select o.status into v_status
      from app.orders o
      where o.business_id = new.business_id and o.id = new.order_id and o.deleted_at is null;
      -- An unknown order is left to the foreign key.
      if found and new.kind = 'payment' and v_status not in ('pending', 'delivered') then
        raise exception 'a payment is recorded only on a pending or delivered order'
          using errcode = 'check_violation';
      end if;
    else
      select s.status, s.source, s.pay_later into v_status, v_source, v_pay_later
      from app.sales s
      where s.business_id = new.business_id and s.id = new.sale_id and s.deleted_at is null;
      -- A payment on a finalized sale "they'll pay later"; money given back on one, or on a sale an
      -- issued invoice was made from (it was paid there, perhaps when made).
      if found
        and (v_status <> 'posted' or v_source <> 'single' or not v_pay_later)
        and (new.kind = 'payment' or not exists (
          select 1 from app.invoices i
           where i.business_id = new.business_id and i.sale_id = new.sale_id
             and i.status = 'issued' and i.deleted_at is null
        ))
      then
        raise exception 'a payment is recorded only on a finalized sale they pay later'
          using errcode = 'check_violation';
      end if;
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

----------------------------------------------------------------------------------------------------
-- A sale keeps its invoice; an order an issued invoice refers to keeps its delivery (SALE_HAS_INVOICE)
----------------------------------------------------------------------------------------------------

-- As orders_security, and: an invoice's or a credit note's sale is never reversed (an issued document
-- is corrected only by a credit note); a sale an issued invoice was made from, or the sale of an order
-- an issued invoice refers to, is not reversed (the API says SALE_HAS_INVOICE first).
create or replace function app.sales_keep_dependents()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source in ('invoice', 'credit_note') then
    raise exception 'the sale of an issued invoice or credit note is never reversed'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from app.customer_payments cp
     where cp.business_id = new.business_id and cp.sale_id = new.id
       and cp.reversed_at is null and cp.deleted_at is null
  ) then
    raise exception 'a sale with payments is reversed only once its payments are'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from app.sales r
     where r.business_id = new.business_id and r.refund_of_id = new.id
       and r.status = 'posted' and r.deleted_at is null
  ) then
    raise exception 'a sale with refunds is reversed only once its refunds are'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from app.invoices i
     where i.business_id = new.business_id and i.status = 'issued' and i.deleted_at is null
       and (i.sale_id = new.id or (new.order_id is not null and i.order_id = new.order_id))
  ) then
    raise exception 'a sale an issued invoice refers to is never reversed'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- An order an issued invoice refers to is never cancelled and its delivery is not undone (credit the
-- invoice first). Wraps orders_security's guard_order.
create function app.orders_keep_invoices()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from app.invoices i
     where i.business_id = new.business_id and i.order_id = new.id
       and i.status = 'issued' and i.deleted_at is null
  ) then
    raise exception 'an order an issued invoice refers to is not cancelled or undone'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger keep_invoices before update on app.orders
  for each row
  when (
    (old.status = 'pending' and new.status = 'cancelled')
    or (old.status = 'delivered' and new.status = 'pending')
  )
  execute function app.orders_keep_invoices();

----------------------------------------------------------------------------------------------------
-- Invoices' files, and an invoice line's picture (images, only while its invoice is a draft)
----------------------------------------------------------------------------------------------------

-- As quotations_security, with entity `invoice` (the customer's signed delivery note, their LPO: on any
-- live invoice, also once issued) and `invoice_line` (a picture printed in the PDF: on a line of a draft
-- invoice only, and taken off only while it is a draft, so an issued invoice prints as it was issued).
create or replace function app.check_attachment_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE'
    and (new.entity is distinct from old.entity or new.entity_id is distinct from old.entity_id)
  then
    raise exception 'an attachment cannot move to another record' using errcode = 'check_violation';
  end if;
  if new.entity in ('quotation_line', 'invoice_line')
    and (tg_op = 'INSERT' or (old.deleted_at is null and new.deleted_at is not null))
  then
    if new.entity = 'quotation_line' then
      select q.status into v_status
      from app.quotation_lines l
      join app.quotations q on q.business_id = l.business_id and q.id = l.quotation_id
      where l.business_id = new.business_id and l.id = new.entity_id
        and l.deleted_at is null and q.deleted_at is null
      for share of l, q;
    else
      select i.status into v_status
      from app.invoice_lines l
      join app.invoices i on i.business_id = l.business_id and i.id = l.invoice_id
      where l.business_id = new.business_id and l.id = new.entity_id
        and l.deleted_at is null and i.deleted_at is null
      for share of l, i;
    end if;
    if not found then
      raise exception 'attachment target % % is not a live record of this business',
        new.entity, new.entity_id
        using errcode = 'foreign_key_violation';
    end if;
    if v_status <> 'draft' then
      raise exception 'the picture of a sent quotation''s or issued invoice''s line never changes'
        using errcode = 'restrict_violation';
    end if;
    return new;
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
    elsif new.entity = 'order' then
      perform 1 from app.orders o
      where o.business_id = new.business_id and o.id = new.entity_id and o.deleted_at is null
      for share;
    elsif new.entity = 'quotation' then
      perform 1 from app.quotations q
      where q.business_id = new.business_id and q.id = new.entity_id and q.deleted_at is null
      for share;
    elsif new.entity = 'invoice' then
      perform 1 from app.invoices i
      where i.business_id = new.business_id and i.id = new.entity_id and i.deleted_at is null
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
-- New permission keys for existing template roles (as D-124 did for M2 Step 2)
----------------------------------------------------------------------------------------------------

-- Invoices declares its keys now (it stays unreleased until Release B, M3 Step 9). The pairs below
-- must equal the new keys of role-templates.ts in @bizcost/modules (the plan's Q10 table, D-218): the
-- Manager and the Accountant see, prepare, issue and credit; Sales sees and prepares (not issue). Admin
-- holds every key. Members holding a changed role get a new permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'invoices.documents.view'),
    ('admin', 'invoices.documents.manage'),
    ('admin', 'invoices.documents.issue'),
    ('admin', 'invoices.documents.credit'),
    ('manager', 'invoices.documents.view'),
    ('manager', 'invoices.documents.manage'),
    ('manager', 'invoices.documents.issue'),
    ('manager', 'invoices.documents.credit'),
    ('accountant', 'invoices.documents.view'),
    ('accountant', 'invoices.documents.manage'),
    ('accountant', 'invoices.documents.issue'),
    ('accountant', 'invoices.documents.credit'),
    ('sales', 'invoices.documents.view'),
    ('sales', 'invoices.documents.manage')
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

alter function app.guard_issued_document() owner to postgres;
alter function app.guard_document_lines() owner to postgres;
alter function app.guard_customer_payment() owner to postgres;
alter function app.sales_keep_dependents() owner to postgres;
alter function app.orders_keep_invoices() owner to postgres;
alter function app.check_attachment_target() owner to postgres;

revoke all on function app.guard_issued_document() from public, anon, authenticated;
revoke all on function app.guard_document_lines() from public, anon, authenticated;
revoke all on function app.guard_customer_payment() from public, anon, authenticated;
revoke all on function app.sales_keep_dependents() from public, anon, authenticated;
revoke all on function app.orders_keep_invoices() from public, anon, authenticated;
revoke all on function app.check_attachment_target() from public, anon, authenticated;
grant execute on function app.guard_issued_document() to bizcost_api;
grant execute on function app.guard_document_lines() to bizcost_api;
grant execute on function app.guard_customer_payment() to bizcost_api;
grant execute on function app.sales_keep_dependents() to bizcost_api;
grant execute on function app.orders_keep_invoices() to bizcost_api;
grant execute on function app.check_attachment_target() to bizcost_api;
