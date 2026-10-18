-- pgTAP: Quotations, document numbers and PDFs (M3 Step 7; migrations quotations_tables,
-- quotations_security and order_round_total; DECISIONS.md from D-283). As bizcost_api, like the API:
--   - the four new tables are isolated between businesses and link only within one (composite
--     foreign keys: a quotation's customer, location, order, first revision and source; a line's
--     quotation and product; a stage's quotation);
--   - their CHECKs: value lists, a revision's first revision, validity on or after the date, the sent,
--     answered and superseded columns together, "Round the total" with what it typed, an area's
--     name of at most 40 characters (migration quotation_area_length, D-299);
--   - numbering: one live revision per number and revision (a discarded draft's count used again), one draft at a time per quotation, one order
--     per quotation; a counter's first number set only before its first document;
--   - a revision is frozen once sent (guard_quotation): only its answer, its supersession and its order
--     and invoice links change; a draft is discarded, a sent one never; lines and stages change only
--     while it is a draft;
--   - PDFs made are append-only, at most 20 per member a minute (BZ429);
--   - files: a line's picture is an image, on a draft only; a quotation's own file also once sent; the
--     upload registry's new purposes;
--   - the businesses' document settings and contact lines, and typed items on orders and sales (Q21).
begin;
select plan(84);

do $$
begin
  if not pg_has_role(current_user, 'bizcost_api', 'SET') then
    execute format('grant bizcost_api to %I', current_user);
  end if;
exception when others then
  raise warning 'cannot let % SET ROLE bizcost_api: %', current_user, sqlerrm;
end
$$;

create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5(p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

create function pg_temp.api_run(p_user text, p_business text, p_sql text, p_scalar boolean)
returns text
language plpgsql
as $$
declare
  v_out text;
  v_rows bigint;
begin
  perform set_config('app.user_id', coalesce(pg_temp.id(p_user)::text, ''), true);
  perform set_config('app.business_id', coalesce(pg_temp.id(p_business)::text, ''), true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    if p_scalar then
      execute p_sql into v_out;
    else
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_out := 'ok ' || v_rows;
    end if;
  exception when others then
    v_out := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  perform set_config('app.user_id', '', true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.request_id', '', true);
  return v_out;
end
$$;

create function pg_temp.api_exec(p_user text, p_business text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, false) $$;

create function pg_temp.api_value(p_user text, p_business text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, true) $$;

create function pg_temp.state_of(p_result text)
returns text language sql immutable
as $$ select case when p_result like 'ERROR %' then substr(p_result, 7, 5) else p_result end $$;

-- A quotation of A for A's customer (revision 1 is its own root), on 20 January 2026.
create function pg_temp.quote_sql(p_id text, p_seq int, p_extra_columns text default '',
                                  p_extra_values text default '', p_root text default null,
                                  p_revision int default 1)
returns text language sql immutable
as $$
  select format($f$
    insert into app.quotations (id, business_id, seq, number, root_id, revision, customer_id,
                                location_id, business_date, currency %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), %s, %L, pg_temp.id(%L), %s, pg_temp.id('cust A'),
            pg_temp.id('loc A'), date '2026-01-20', 'AED' %s) $f$,
    p_extra_columns, p_id, p_seq, 'Q-' || lpad(p_seq::text, 4, '0'), coalesce(p_root, p_id),
    p_revision, p_extra_values)
$$;

-- A typed line (no product) of a quotation.
create function pg_temp.line_sql(p_id text, p_quote text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.quotation_lines (id, business_id, quotation_id, position, description, qty,
                                     unit_price)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id(%L), 0, 'Wall cladding', 1, 100) $f$,
    p_id, p_quote)
$$;

-- Sends a draft (its sent columns).
create function pg_temp.send_sql(p_quote text)
returns text language sql immutable
as $$
  select format($f$
    update app.quotations set status = 'sent', sent_at = now(), sent_by = pg_temp.id('user A')
     where id = pg_temp.id(%L) $f$, p_quote)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amna-quotes@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', pg_temp.id('user B'), 'authenticated',
        'authenticated', 'bilal-quotes@example.test', now(), '{}', '{}', now(), now());

-- 1. Fixtures (14) ------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.u, null, format($f$
    select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner',
                               pg_temp.id(%L), pg_temp.id(%L)) $f$,
    v.b, v.name, v.b || ' owner role', v.b || ' owner member')),
  pg_temp.id(v.b)::text,
  'setup: ' || v.u || ' creates ' || v.b
)
  from (values ('user A', 'biz A', 'Alpha Interiors'), ('user B', 'biz B', 'Beta Joinery')) as v(u, b, name);

select is(pg_temp.api_exec(v.u, v.b, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    (1, 'user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, 'user A', 'biz A', 'a channel of A', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan A'), pg_temp.id('biz A'), 'Shop', 'shop') $$),
    (3, 'user A', 'biz A', 'a customer of A', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust A'), pg_temp.id('biz A'), 'خالد المنصوري') $$),
    (4, 'user A', 'biz A', 'quotation Q-0001 of A, a draft', pg_temp.quote_sql('q1', 1)),
    (5, 'user A', 'biz A', 'its typed line', pg_temp.line_sql('q1 line', 'q1')),
    (6, 'user A', 'biz A', 'quotation Q-0002 of A', pg_temp.quote_sql('q2', 2)),
    (7, 'user A', 'biz A', 'its line', pg_temp.line_sql('q2 line', 'q2')),
    (71, 'user A', 'biz A', 'quotation Q-0003 of A, a draft', pg_temp.quote_sql('q3', 3)),
    (72, 'user A', 'biz A', 'its line', pg_temp.line_sql('q3 line', 'q3')),
    (8, 'user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    (9, 'user B', 'biz B', 'a customer of B', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust B'), pg_temp.id('biz B'), 'Badria') $$),
    (10, 'user B', 'biz B', 'B''s own Q-0001 (numbers are per business)', $$
      insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                  business_date, currency)
      values (pg_temp.id('qB'), pg_temp.id('biz B'), 1, 'Q-0001', pg_temp.id('qB'),
              pg_temp.id('cust B'), pg_temp.id('loc B'), date '2026-01-20', 'AED') $$)
  ) as v(n, u, b, what, stmt)
 order by v.n;

-- 2. Isolation and links (8) ----------------------------------------------------------------------

select is(pg_temp.api_value('user A', 'biz A', 'select count(*)::text from app.quotations'), '3',
          'A sees its own quotations only');
select is(pg_temp.api_value('user B', 'biz B', 'select count(*)::text from app.quotation_lines'), '0',
          'B sees none of A''s lines');
select is(pg_temp.api_exec('user B', 'biz B', $$
  update app.quotations set notes = 'x' where id = pg_temp.id('q1') $$), 'ok 0',
          'B cannot change A''s quotation');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                              business_date, currency)
  values (pg_temp.id('x cust'), pg_temp.id('biz A'), 9, 'Q-0009', pg_temp.id('x cust'),
          pg_temp.id('cust B'), pg_temp.id('loc A'), date '2026-01-20', 'AED') $$)), '23503',
          'a quotation names a customer of its own business only');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.quotation_lines (id, business_id, quotation_id, position, description, qty,
                                   unit_price)
  values (pg_temp.id('x line'), pg_temp.id('biz A'), pg_temp.id('qB'), 0, 'X', 1, 1) $$)), '23503',
          'a line belongs to a quotation of its own business only');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.quote_sql('x root', 9, '', '', 'qB', 2))), '23503',
          'a revision''s first revision is of its own business');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.quotation_stages (id, business_id, quotation_id, position, due, percent, amount)
  values (pg_temp.id('x stage'), pg_temp.id('biz A'), pg_temp.id('qB'), 0, 'Now', 100, 1) $$)),
          '23503', 'a stage belongs to a quotation of its own business only');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.document_renders (id, business_id, kind, document_id)
  values (pg_temp.id('x render'), pg_temp.id('biz B'), 'quotation', pg_temp.id('qB')) $$)), '42501',
          'a PDF is counted in the caller''s business only (RLS)');

-- 3. CHECKs (14) --------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23514', 'check: ' || v.what)
  from (values
    (1, 'a status from the list', pg_temp.quote_sql('c1', 31, ', status', ', ''expired''')),
    (2, 'a first revision is its own root', pg_temp.quote_sql('c2', 32, '', '', 'q1', 1)),
    (3, 'a later revision is not', pg_temp.quote_sql('c3', 33, '', '', 'c3', 2)),
    (4, 'valid until on or after its day', pg_temp.quote_sql('c4', 34, ', valid_until',
      ', date ''2026-01-19''')),
    (5, 'a sent quotation says when and who', pg_temp.quote_sql('c5', 35, ', status',
      ', ''sent''')),
    (6, 'an accepted one says when and who', pg_temp.quote_sql('c6', 36,
      ', status, sent_at, sent_by', ', ''accepted'', now(), pg_temp.id(''user A'')')),
    (7, 'an adjustment goes with the total typed', pg_temp.quote_sql('c7', 37, ', adjustment',
      ', -5')),
    (8, 'a superseded one says when', pg_temp.quote_sql('c8', 38,
      ', status, sent_at, sent_by', ', ''superseded'', now(), pg_temp.id(''user A'')')),
    (9, 'a line''s quantity is more than zero', $$
      update app.quotation_lines set qty = 0 where id = pg_temp.id('q1 line') $$),
    (10, 'a stage''s share is from 0 to 100', $$
      insert into app.quotation_stages (id, business_id, quotation_id, position, due, percent,
                                        amount)
      values (pg_temp.id('c10'), pg_temp.id('biz A'), pg_temp.id('q1'), 0, 'Now', 120, 1) $$),
    (11, 'an accent from the palette', $$
      update app.businesses set document_accent = 'pink' where id = pg_temp.id('biz A') $$),
    (12, 'an emirate only in the UAE', $$
      update app.businesses set emirate = 'atlantis' where id = pg_temp.id('biz A') $$),
    (13, 'an area''s name is at most 40 characters (D-299: it prints up its lines'' side)', $$
      update app.quotation_lines set area = repeat('م', 41) where id = pg_temp.id('q3 line') $$)
  ) as v(n, what, stmt)
 order by v.n;

select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotation_lines set area = repeat('م', 40) where id = pg_temp.id('q3 line') $$), 'ok 1',
          'check: an area''s name of 40 characters is kept');

-- 4. Numbers (6) --------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23505', 'one revision per number and revision', pg_temp.quote_sql('n1', 1)),
    (2, '23505', 'one draft at a time per quotation (revision 2 while 1 is a draft)',
      pg_temp.quote_sql('n2', 1, '', '', 'q1', 2)),
    (3, 'ok 1', 'a counter of quotations starts where the business says', $$
      insert into app.document_counters (id, business_id, series, next_no, first_no, prefix, padding)
      values (pg_temp.id('ctr Q'), pg_temp.id('biz A'), 'quotation', 501, 501, 'Q-', 4) $$),
    (4, 'ok 1', 'its first number moves before its first document', $$
      update app.document_counters set first_no = 1, next_no = 1 where id = pg_temp.id('ctr Q') $$),
    (5, 'ok 1', 'a document takes its number', $$
      update app.document_counters set next_no = 2 where id = pg_temp.id('ctr Q') $$),
    (6, '23514', 'then its first number no longer changes', $$
      update app.document_counters set first_no = 2, next_no = 2 where id = pg_temp.id('ctr Q') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 5. A revision frozen once sent (14) -------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a draft changes', $$
      update app.quotations set notes = 'Second floor', total = 105 where id = pg_temp.id('q1') $$),
    (2, 'ok 1', 'its lines change while it is a draft', $$
      update app.quotation_lines set qty = 2 where id = pg_temp.id('q1 line') $$),
    (3, 'ok 1', 'it is sent', pg_temp.send_sql('q1')),
    (4, '23001', 'then it is never edited', $$
      update app.quotations set notes = 'changed' where id = pg_temp.id('q1') $$),
    (5, '23001', 'nor its lines', $$
      update app.quotation_lines set qty = 3 where id = pg_temp.id('q1 line') $$),
    (6, '23001', 'nor is a line added', pg_temp.line_sql('q1 line 2', 'q1')),
    (7, '23001', 'nor is it discarded', $$
      update app.quotations set deleted_at = now() where id = pg_temp.id('q1') $$),
    (8, '23514', 'its number and revision never change', $$
      update app.quotations set seq = 7 where id = pg_temp.id('q1') $$),
    (9, 'ok 1', 'revision 2 is made', pg_temp.quote_sql('q1 r2', 1, '', '', 'q1', 2)),
    (10, 'ok 1', 'revision 1 is superseded once revision 2 is sent', $$
      update app.quotations set status = 'superseded', superseded_at = now()
       where id = pg_temp.id('q1') $$),
    (11, 'ok 1', 'revision 2 is sent', pg_temp.send_sql('q1 r2')),
    (12, '23001', 'an answer changes only its columns', $$
      update app.quotations set status = 'accepted', accepted_at = now(),
                                accepted_by = pg_temp.id('user A'), notes = 'x'
       where id = pg_temp.id('q1 r2') $$),
    (13, 'ok 1', 'the customer accepts it', $$
      update app.quotations set status = 'accepted', accepted_at = now(),
                                accepted_by = pg_temp.id('user A'), accept_note = 'Signed'
       where id = pg_temp.id('q1 r2') $$),
    (14, '23001', 'a quotation is never deleted', $$
      delete from app.quotations where id = pg_temp.id('q2') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 6. Its order, once (4) ------------------------------------------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                          channel_id, currency)
  values (pg_temp.id('ord A'), pg_temp.id('biz A'), 1001, '#1001', pg_temp.id('cust A'),
          date '2026-01-20', pg_temp.id('loc A'), pg_temp.id('chan A'), 'AED') $$), 'ok 1',
          'setup: an order of A');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotations set order_id = pg_temp.id('ord A') where id = pg_temp.id('q1 r2') $$),
          'ok 1', 'the accepted revision is linked to its order');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotations set order_id = null where id = pg_temp.id('q1 r2') $$)), '23001',
          'and keeps it');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotations set order_id = pg_temp.id('ord A') where id = pg_temp.id('q2') $$)), '23514',
          'an order comes from an accepted revision only');

-- 7. Discarding a draft (7) -----------------------------------------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotations set deleted_at = now() where id = pg_temp.id('q2') $$), 'ok 1',
          'a draft is discarded');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotations set notes = 'again' where id = pg_temp.id('q2') $$)), '23001',
          'a discarded draft never changes again');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotation_lines set qty = 5 where id = pg_temp.id('q2 line') $$)), '23001',
          'nor do its lines change');
-- A revision counts n + 1 over the live ones: a discarded draft revision's count is used again (D-296).
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.quote_sql('q1 r3', 1, '', '', 'q1', 3)), 'ok 1',
          'setup: a draft revision 3');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.quotations set deleted_at = now() where id = pg_temp.id('q1 r3') $$), 'ok 1',
          'the draft revision 3 is discarded');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.quote_sql('q1 r3 again', 1, '', '', 'q1', 3)),
          'ok 1', 'a discarded draft revision''s count is used again');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
          pg_temp.quote_sql('q1 r3 twice', 1, '', '', 'q1', 3))), '23505',
          'and a live revision 3 stays one of a kind');

-- 8. Files (6) ------------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23001', 'a picture is never added to a line of a sent quotation', $$
      insert into app.attachments (id, business_id, entity, entity_id, path, file_name,
                                   content_type, size_bytes)
      values (pg_temp.id('a1'), pg_temp.id('biz A'), 'quotation_line', pg_temp.id('q1 line'),
              pg_temp.id('biz A')::text || '/quotation_line/a1.png', 'a.png', 'image/png', 10) $$),
    (2, '23514', 'a line''s picture is an image', $$
      insert into app.attachments (id, business_id, entity, entity_id, path, file_name,
                                   content_type, size_bytes)
      values (pg_temp.id('a2'), pg_temp.id('biz A'), 'quotation_line', pg_temp.id('q3 line'),
              pg_temp.id('biz A')::text || '/quotation_line/a2.pdf', 'a.pdf', 'application/pdf',
              10) $$),
    (3, 'ok 1', 'a signed copy is attached to a sent quotation', $$
      insert into app.attachments (id, business_id, entity, entity_id, path, file_name,
                                   content_type, size_bytes)
      values (pg_temp.id('a3'), pg_temp.id('biz A'), 'quotation', pg_temp.id('q1 r2'),
              pg_temp.id('biz A')::text || '/quotation/a3.pdf', 'signed.pdf', 'application/pdf',
              10) $$),
    (4, 'ok 1', 'an upload of a signature is registered', $$
      insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
      values (pg_temp.id('u1'), pg_temp.id('biz A'), pg_temp.id('biz A')::text || '/signature/u1.png',
              'signature', 'image/png', now() + interval '1 hour') $$),
    (5, 'ok 1', 'an issued document''s PDF is registered', $$
      insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
      values (pg_temp.id('u2'), pg_temp.id('biz A'), pg_temp.id('biz A')::text || '/document/u2.pdf',
              'document', 'application/pdf', now() + interval '1 hour') $$),
    (6, '23514', 'an upload''s purpose is from the list', $$
      insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
      values (pg_temp.id('u3'), pg_temp.id('biz A'), pg_temp.id('biz A')::text || '/other/u3.png',
              'other', 'image/png', now() + interval '1 hour') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 9. PDFs made: append-only, rate-limited (5) -----------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.document_renders (id, business_id, kind, document_id)
    select gen_random_uuid(), pg_temp.id('biz A'), 'quotation', pg_temp.id('q1')
      from generate_series(1, 20) $$),
  'ok 20',
  'a member makes 20 PDFs in a minute'
);
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.document_renders (id, business_id, kind, document_id)
  values (gen_random_uuid(), pg_temp.id('biz A'), 'quotation', pg_temp.id('q1')) $$)), 'BZ429',
          'the 21st waits for the next minute');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.document_renders set kind = 'quotation' where business_id = pg_temp.id('biz A') $$)),
          '23001', 'a PDF made is never changed');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  delete from app.document_renders where business_id = pg_temp.id('biz A') $$)), '23001',
          'nor deleted');
select is(pg_temp.api_exec('user B', 'biz B', $$
  insert into app.document_renders (id, business_id, kind, document_id)
  values (gen_random_uuid(), pg_temp.id('biz B'), 'quotation', pg_temp.id('qB')) $$), 'ok 1',
          'another business counts on its own');

-- 10. The documents' settings, and typed items on orders and sales (6) ----------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'the letterhead and the documents'' settings are saved', $$
      update app.businesses set phone = '+971 4 555 0142', email = 'hello@example.test',
                                address_line = 'Warehouse 7', emirate = 'dubai',
                                document_accent = 'black', document_watermark = false,
                                quotation_valid_days = 7, document_signatory = 'Amna'
       where id = pg_temp.id('biz A') $$),
    (2, '23514', 'a quotation is valid for 1 to 365 days', $$
      update app.businesses set quotation_valid_days = 0 where id = pg_temp.id('biz A') $$),
    (3, 'ok 1', 'an order takes a typed item (it names itself)', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, description, qty,
                                   unit_price)
      values (pg_temp.id('typed line'), pg_temp.id('biz A'), pg_temp.id('ord A'), 0, 'item',
              'Site visit', 1, 300) $$),
    (4, '23514', 'an item without a product names itself', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, qty, unit_price)
      values (pg_temp.id('nameless'), pg_temp.id('biz A'), pg_temp.id('ord A'), 1, 'item', 1,
              300) $$),
    (5, 'ok 1', 'an order keeps the quotation''s "Round the total"', $$
      update app.orders set round_to = 1000, adjustment = -4.76 where id = pg_temp.id('ord A') $$),
    (6, '23514', 'an order''s adjustment goes with the total typed', $$
      update app.orders set round_to = null where id = pg_temp.id('ord A') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

select * from finish();
rollback;
