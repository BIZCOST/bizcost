-- BizCost: Quotations, document numbers and PDFs (M3 Step 7). Hand-written part of the quotations
-- tables: row level security and the touch and audit triggers; a revision frozen once sent (only its
-- answer, its supersession and its order and invoice links may still be written), its lines and payment
-- stages changed only while it is a draft; the log of PDFs made, append-only, with the rate limit
-- counted in the database; a counter's first number settable until its first document; quotations'
-- files (a signed copy) and a line's picture (images, only while its quotation is a draft); the hourly
-- limits of the signature, stamp and document uploads; and the new keys for the roles that businesses
-- already have. See docs/DATA_MODEL.md §6 and DECISIONS.md (M3 Step 7, from D-283).
--
-- Rules as in tenancy_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE; functions
-- have SET search_path = '' with schema-qualified names, owner postgres, and EXECUTE revoked from
-- PUBLIC/anon/authenticated (trigger functions run as the trigger fires).

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.quotations');
select app.apply_tenant_rls('app.quotation_lines');
select app.apply_tenant_rls('app.quotation_stages');
select app.apply_tenant_rls('app.document_renders');

create trigger touch_row before update on app.quotations
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.quotations
  for each row execute function app.audit_row();

create trigger touch_row before update on app.quotation_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.quotation_lines
  for each row execute function app.audit_row();

create trigger touch_row before update on app.quotation_stages
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.quotation_stages
  for each row execute function app.audit_row();

create trigger touch_row before update on app.document_renders
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.document_renders
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- A revision is frozen once sent (Q25)
----------------------------------------------------------------------------------------------------

-- A draft changes freely (its number, quotation and revision never do), is sent (any of its columns
-- may be written with it: the amounts are worked out once more as it is sent) or discarded (soft
-- deleted; a discarded draft never changes again). A sent revision is never edited or deleted: it is
-- answered (sent → accepted or declined, only its answer's columns), superseded once a later revision
-- is sent (only `status` and `superseded_at`), and linked once to the order and the invoice made from
-- it. Rows are never deleted, hard or soft, but a draft.
create function app.guard_quotation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_meta text[] := array['updated_at', 'updated_by', 'version'];
  v_answer text[] := array[
    'status', 'accepted_at', 'accepted_by', 'accept_note', 'declined_at', 'declined_by',
    'decline_reason', 'updated_at', 'updated_by', 'version'
  ];
  v_supersede text[] := array['status', 'superseded_at', 'updated_at', 'updated_by', 'version'];
  v_order text[] := array['order_id', 'updated_at', 'updated_by', 'version'];
  v_invoice text[] := array['invoice_id', 'updated_at', 'updated_by', 'version'];
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception 'app.quotations rows are never deleted (a draft is discarded)'
      using errcode = 'restrict_violation';
  end if;
  if new.seq is distinct from old.seq or new.number is distinct from old.number
    or new.root_id is distinct from old.root_id or new.revision is distinct from old.revision
  then
    raise exception 'a quotation keeps its number and revision' using errcode = 'check_violation';
  end if;
  v_old := pg_catalog.to_jsonb(old);
  v_new := pg_catalog.to_jsonb(new);
  if old.status = 'draft' then
    if old.deleted_at is not null then
      raise exception 'a discarded quotation never changes' using errcode = 'restrict_violation';
    end if;
    if new.status = 'draft' or (new.status = 'sent' and new.deleted_at is null) then
      return new;
    end if;
    raise exception 'a draft quotation is sent before it is answered'
      using errcode = 'check_violation';
  end if;
  if (v_old - v_meta) = (v_new - v_meta) then
    return new;
  end if;
  if old.status = 'sent' and new.status in ('accepted', 'declined')
    and (v_old - v_answer) = (v_new - v_answer)
  then
    return new;
  end if;
  if old.status in ('sent', 'accepted', 'declined') and new.status = 'superseded'
    and (v_old - v_supersede) = (v_new - v_supersede)
  then
    return new;
  end if;
  if old.order_id is null and new.order_id is not null and (v_old - v_order) = (v_new - v_order) then
    return new;
  end if;
  if old.invoice_id is null and new.invoice_id is not null
    and (v_old - v_invoice) = (v_new - v_invoice)
  then
    return new;
  end if;
  raise exception 'a sent quotation is never edited (revise it instead)'
    using errcode = 'restrict_violation';
end
$$;

create trigger guard_quotation before update or delete on app.quotations
  for each row execute function app.guard_quotation();

-- A quotation's lines and payment stages change only while it is a draft (taken out: soft-deleted);
-- never deleted, never moved to another quotation.
create function app.guard_quotation_children()
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
  if tg_op = 'UPDATE' and old.quotation_id is distinct from new.quotation_id then
    raise exception 'a quotation line or stage cannot move to another quotation'
      using errcode = 'check_violation';
  end if;
  select q.status, q.deleted_at is not null into v_status, v_discarded
  from app.quotations q
  where q.business_id = new.business_id and q.id = new.quotation_id;
  -- An unknown quotation is left to the foreign key (it reports the right error).
  if v_status is not null and (v_status <> 'draft' or v_discarded) then
    raise exception 'the lines and stages of a sent quotation are never changed (revise it)'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger guard_quotation_lines before insert or update or delete on app.quotation_lines
  for each row execute function app.guard_quotation_children();
create trigger guard_quotation_stages before insert or update or delete on app.quotation_stages
  for each row execute function app.guard_quotation_children();

----------------------------------------------------------------------------------------------------
-- PDFs made: append-only, rate-limited in the database
----------------------------------------------------------------------------------------------------

-- At most 300 PDFs per business in an hour and 20 per member in a minute, counted here so every API
-- instance counts the others (a transaction-level advisory lock per business makes concurrent requests
-- count each other). Over a limit: SQLSTATE BZ429 (`rate_limited`). A render is never changed or
-- deleted. It runs as the caller: the business's own renders are all it counts (RLS).
create function app.document_render_limits()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'app.document_renders rows are never changed or deleted'
      using errcode = 'restrict_violation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.document_render_limits:' || new.business_id::text, 0)
  );
  if (
    select pg_catalog.count(*)
    from app.document_renders r
    where r.business_id = new.business_id
      and r.created_at > pg_catalog.now() - interval '1 hour'
  ) >= 300 then
    raise exception 'document_render_limit: at most 300 documents per business in an hour'
      using errcode = 'BZ429';
  end if;
  if (
    select pg_catalog.count(*)
    from app.document_renders r
    where r.business_id = new.business_id
      and r.created_by = new.created_by
      and r.created_at > pg_catalog.now() - interval '1 minute'
  ) >= 20 then
    raise exception 'document_render_limit: at most 20 documents per member in a minute'
      using errcode = 'BZ429';
  end if;
  return new;
end
$$;

create trigger document_render_limits before insert or update or delete on app.document_renders
  for each row execute function app.document_render_limits();

----------------------------------------------------------------------------------------------------
-- A counter's first number, until its first document (Q25)
----------------------------------------------------------------------------------------------------

-- A number given is never taken back: the counter only moves forward. Before its first document
-- (next_no = first_no) the business may set where the series starts (Settings → Documents): its
-- first number and next number then change together. Replaces orders_security's version.
create or replace function app.guard_document_counter()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.series is distinct from old.series then
    raise exception 'a document counter keeps its series' using errcode = 'check_violation';
  end if;
  if old.next_no = old.first_no and new.next_no = new.first_no then
    return new;
  end if;
  if new.first_no is distinct from old.first_no or new.next_no < old.next_no then
    raise exception 'a document counter only moves forward; its first number is set before its first document'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

----------------------------------------------------------------------------------------------------
-- Quotations' files, and a line's picture (images, only while its quotation is a draft)
----------------------------------------------------------------------------------------------------

-- As orders_security, with entity `quotation` (the customer's signed copy, drawings: on any live
-- quotation, also once sent) and `quotation_line` (a picture printed in the PDF: on a line of a draft
-- quotation only, and taken off only while it is a draft, so a sent revision prints as it was sent).
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
  if new.entity = 'quotation_line'
    and (tg_op = 'INSERT' or (old.deleted_at is null and new.deleted_at is not null))
  then
    select q.status into v_status
    from app.quotation_lines l
    join app.quotations q on q.business_id = l.business_id and q.id = l.quotation_id
    where l.business_id = new.business_id and l.id = new.entity_id
      and l.deleted_at is null and q.deleted_at is null
    for share of l, q;
    if not found then
      raise exception 'attachment target % % is not a live record of this business',
        new.entity, new.entity_id
        using errcode = 'foreign_key_violation';
    end if;
    if v_status <> 'draft' then
      raise exception 'the picture of a sent quotation''s line never changes (revise it)'
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
-- Uploads: the signature, the stamp and issued documents have their own hourly limits
----------------------------------------------------------------------------------------------------

-- At most 10 logo, 10 signature and 10 stamp uploads, 300 attachments and 500 issued documents per
-- business in an hour (each purpose counted on its own). Attachments rise from 100 to 300: a revised or
-- copied quotation copies its lines' pictures, each registered like an upload. Replaces
-- purchasing_security's version.
create or replace function app.file_upload_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := case new.purpose
    when 'attachment' then 300
    when 'document' then 500
    else 10
  end;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.file_upload_limits:' || new.business_id::text, 0)
  );
  if (
    select pg_catalog.count(*)
    from app.file_uploads u
    where u.business_id = new.business_id
      and u.purpose = new.purpose
      and u.created_at > pg_catalog.now() - interval '1 hour'
  ) >= v_limit then
    raise exception 'file_upload_limit: at most % % uploads per business in an hour',
      v_limit, new.purpose
      using errcode = 'BZ429';
  end if;
  return new;
end
$$;

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (as D-124 did for M2 Step 2)
----------------------------------------------------------------------------------------------------

-- Quotations declares its keys now (it stays unreleased until Release B, M3 Step 9), and Settings
-- gains "Manage documents" (numbers, letterhead, signature; the Owner and the Admin). The pairs below
-- must equal the new keys of role-templates.ts in @bizcost/modules (the plan's Q10 table, D-218): the
-- Manager and Sales see, prepare and record the customer's answer; the Accountant sees them. Members
-- holding a changed role get a new permissions_version.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'settings.documents.manage'),
    ('admin', 'quotations.documents.view'),
    ('admin', 'quotations.documents.manage'),
    ('admin', 'quotations.documents.decide'),
    ('manager', 'quotations.documents.view'),
    ('manager', 'quotations.documents.manage'),
    ('manager', 'quotations.documents.decide'),
    ('accountant', 'quotations.documents.view'),
    ('sales', 'quotations.documents.view'),
    ('sales', 'quotations.documents.manage'),
    ('sales', 'quotations.documents.decide')
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

alter function app.guard_quotation() owner to postgres;
alter function app.guard_quotation_children() owner to postgres;
alter function app.document_render_limits() owner to postgres;
alter function app.guard_document_counter() owner to postgres;
alter function app.check_attachment_target() owner to postgres;
alter function app.file_upload_limits() owner to postgres;

revoke all on function app.guard_quotation() from public, anon, authenticated;
revoke all on function app.guard_quotation_children() from public, anon, authenticated;
revoke all on function app.document_render_limits() from public, anon, authenticated;
revoke all on function app.guard_document_counter() from public, anon, authenticated;
revoke all on function app.check_attachment_target() from public, anon, authenticated;
revoke all on function app.file_upload_limits() from public, anon, authenticated;
grant execute on function app.guard_quotation() to bizcost_api;
grant execute on function app.guard_quotation_children() to bizcost_api;
grant execute on function app.document_render_limits() to bizcost_api;
grant execute on function app.guard_document_counter() to bizcost_api;
grant execute on function app.check_attachment_target() to bizcost_api;
grant execute on function app.file_upload_limits() to bizcost_api;
