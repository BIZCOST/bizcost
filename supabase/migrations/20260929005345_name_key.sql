-- BizCost: material names compared the way people read them (the owner's request of 2026-09-29).
--
-- app.name_key(name) is the key that nameKey in @bizcost/domain (catalog/names.ts) gives: lower case;
-- alef with hamza or madda and alef wasla become alef, teh marbuta heh, alef maksura yeh; the
-- tashkeel (U+064B to U+065F, U+0670) and the tatweel (U+0640) are dropped; Arabic-Indic and Extended
-- Arabic-Indic digits become 0 to 9; each run of spaces becomes one space; both ends are trimmed. The
-- next migration builds the unique index of material names on it (materials_name_key), so "سكّر" and
-- "سكر", or "Brown  sugar" and "brown sugar", are one name (NAME_TAKEN). An API test compares the two
-- functions on the same names.
--
-- Live materials of a business that already share a key (local and demo data only: nothing is
-- released yet) keep the oldest name; each later one becomes "<name> (2)", "(3)"… (cut to 100
-- characters) until its key is free, and an item bought ready to sell renames its product with it
-- (D-117 keeps the pair in step). Each rename is audited by audit_row, like any other write.

create function app.name_key(value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
return pg_catalog.btrim(
  pg_catalog.regexp_replace(
    pg_catalog.translate(
      pg_catalog.lower(value),
      -- alef forms, teh marbuta, alef maksura; Arabic-Indic and Extended Arabic-Indic digits; then
      -- the marks to drop (no counterpart in the second list, so translate removes them)
      U&'\0623\0625\0622\0671\0629\0649'
        || U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'
        || U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9'
        || U&'\064B\064C\064D\064E\064F\0650\0651\0652\0653\0654\0655\0656\0657\0658\0659'
        || U&'\065A\065B\065C\065D\065E\065F\0670\0640',
      U&'\0627\0627\0627\0627\0647\064A' || '0123456789' || '0123456789'
    ),
    '[ \xA0\x1680\x2000-\x200A\x2028\x2029\x202F\x205F\x3000]+',
    ' ',
    'g'
  ),
  ' '
);

alter function app.name_key(text) owner to postgres;
revoke all on function app.name_key(text) from public, anon, authenticated;
grant execute on function app.name_key(text) to bizcost_api;

-- Materials that already share a key: the later ones get a number (see above).
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
    raise notice 'name_key: material % of business % renamed to %', v_row.id, v_row.business_id,
      v_name;
  end loop;
end
$$;
