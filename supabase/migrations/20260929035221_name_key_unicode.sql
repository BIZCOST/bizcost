-- BizCost: material names that read exactly alike are one name, in whatever Unicode form they come
-- (review of the owner's requests of 2026-09-29, D-158).
--
-- app.name_key (migration name_key) folded case, spaces, Arabic letter forms, marks and digits, but a
-- name pasted with an invisible bidi mark inside, typed on a Persian keyboard, or sent as another
-- Unicode form of the same letters (a letter and its combining mark, Arabic presentation forms) got a
-- key of its own, so the unique index let a second "Sugar" in. The key now, like nameKey in
-- @bizcost/domain (catalog/names.ts), first drops every format character (Unicode 17 category Cf:
-- bidi marks, the Arabic letter mark, joiners, the zero-width space…), then normalizes to NFKC (one
-- form for the same letters), then does what it did, with the Persian letter forms read as the Arabic
-- ones (Farsi yeh → yeh, keheh → kaf, heh goal and ae → heh). Only the key folds: names are stored as
-- typed. An API test holds the two functions equal, over every Cf character too.
--
-- The index of material names is built again on the new key. Live materials of a business that now
-- share a key keep the oldest name; each later one becomes "<name> (2)", "(3)"… (cut to 100
-- characters) until its key is free, and an item bought ready to sell renames its product with it
-- (D-117), as migration name_key did. Each rename is audited by audit_row.

drop index app.materials_name_key;

create or replace function app.name_key(value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
return pg_catalog.btrim(
  pg_catalog.regexp_replace(
    pg_catalog.translate(
      pg_catalog.lower(
        pg_catalog.normalize(
          -- the format characters (Cf), before NFKC so that the letters on both sides compose
          pg_catalog.regexp_replace(
            value,
            '[\xAD\x600-\x605\x61C\x6DD\x70F\x890\x891\x8E2\x180E\x200B-\x200F\x202A-\x202E'
              || '\x2060-\x2064\x2066-\x206F\xFEFF\xFFF9-\xFFFB\x110BD\x110CD\x13430-\x1343F'
              || '\x1BCA0-\x1BCA3\x1D173-\x1D17A\xE0001\xE0020-\xE007F]',
            '',
            'g'
          ),
          'NFKC'
        )
      ),
      -- alef forms; teh marbuta, heh goal, ae; alef maksura, Farsi yeh; keheh; Arabic-Indic and
      -- Extended Arabic-Indic digits; then the marks to drop (no counterpart in the second list, so
      -- translate removes them)
      U&'\0623\0625\0622\0671\0629\06C1\06D5\0649\06CC\06A9'
        || U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'
        || U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9'
        || U&'\064B\064C\064D\064E\064F\0650\0651\0652\0653\0654\0655\0656\0657\0658\0659'
        || U&'\065A\065B\065C\065D\065E\065F\0670\0640',
      U&'\0627\0627\0627\0627\0647\0647\0647\064A\064A\0643' || '0123456789' || '0123456789'
    ),
    '[ \xA0\x1680\x2000-\x200A\x2028\x2029\x202F\x205F\x3000]+',
    ' ',
    'g'
  ),
  ' '
);

-- Materials that now share a key: the later ones get a number (see above).
do $$
declare
  v_row record;
  v_n integer;
  v_suffix text;
  v_name text;
  v_product uuid;
begin
  for v_row in
    select d.id, d.business_id, d.name
    from (
      select m.id, m.business_id, m.name, m.created_at,
             pg_catalog.row_number() over (
               partition by m.business_id, app.name_key(m.name)
               order by m.created_at, m.id
             ) as n
      from app.materials m
      where m.deleted_at is null
    ) d
    where d.n > 1
    order by d.business_id, d.created_at, d.id
  loop
    select p.id into v_product
    from app.products_services p
    where p.business_id = v_row.business_id
      and p.resale_material_id = v_row.id
      and p.deleted_at is null;
    v_n := 2;
    loop
      v_suffix := ' (' || v_n || ')';
      v_name := pg_catalog.rtrim(pg_catalog.left(v_row.name, 100 - pg_catalog.length(v_suffix)))
        || v_suffix;
      exit when not exists (
          select 1 from app.materials o
          where o.business_id = v_row.business_id
            and o.deleted_at is null
            and o.id <> v_row.id
            and app.name_key(o.name) = app.name_key(v_name)
        )
        and (
          v_product is null
          or not exists (
            select 1 from app.products_services o
            where o.business_id = v_row.business_id
              and o.deleted_at is null
              and o.id <> v_product
              and pg_catalog.lower(o.name) = pg_catalog.lower(v_name)
          )
        );
      v_n := v_n + 1;
    end loop;
    update app.materials
    set name = v_name
    where business_id = v_row.business_id and id = v_row.id;
    if v_product is not null then
      update app.products_services
      set name = v_name
      where business_id = v_row.business_id and id = v_product;
    end if;
    raise notice 'name_key_unicode: material % of business % renamed to %', v_row.id,
      v_row.business_id, v_name;
  end loop;
end
$$;

create unique index materials_name_key on app.materials using btree (business_id, app.name_key(name))
  where deleted_at is null;
