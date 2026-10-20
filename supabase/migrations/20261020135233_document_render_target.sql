-- BizCost: a PDF made names a document of its own business (M3 Step 10; D-329). document_renders
-- counts every PDF handed out (at most 300 a business an hour, 20 a member a minute: D-284, D-289);
-- its document_id names a quotation, an invoice, a credit note or, for a statement, a customer: one
-- column for four tables, so no foreign key holds it. Row level security kept the row in the caller's
-- business, but its document_id could name a row of another business, or none
-- (supabase/tests/27_m3_links.test.sql: every M3 link refuses another business's row). Like
-- app.check_attachment_target for files, app.check_render_target refuses it (foreign_key_violation,
-- 23503) unless the document is a row of the same business. A document is never deleted (a draft is
-- discarded: soft-deleted), and a PDF made of it stays counted, so existence is what is checked.

create function app.check_render_target()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'quotation' then
    perform 1 from app.quotations q where q.business_id = new.business_id and q.id = new.document_id;
  elsif new.kind = 'invoice' then
    perform 1 from app.invoices i where i.business_id = new.business_id and i.id = new.document_id;
  elsif new.kind = 'credit_note' then
    perform 1 from app.credit_notes c where c.business_id = new.business_id and c.id = new.document_id;
  elsif new.kind = 'statement' then
    perform 1 from app.customers c where c.business_id = new.business_id and c.id = new.document_id;
  else
    raise exception 'document kind % is unknown', new.kind using errcode = 'check_violation';
  end if;
  if not found then
    raise exception 'document % % is not a record of this business', new.kind, new.document_id
      using errcode = 'foreign_key_violation';
  end if;
  return null;
end
$$;

-- AFTER INSERT, as a foreign key checks: a render over the limit (document_render_limits, BEFORE) and
-- a row of another business (row level security) are refused as before. Rows are never updated
-- (document_render_limits refuses it).
create trigger check_render_target after insert on app.document_renders
  for each row execute function app.check_render_target();

alter function app.check_render_target() owner to postgres;
revoke all on function app.check_render_target() from public, anon, authenticated;
grant execute on function app.check_render_target() to bizcost_api;
