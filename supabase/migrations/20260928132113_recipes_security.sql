-- BizCost: Recipes / product cost (M2 Step 4). Hand-written part of the recipe tables and the link of
-- items bought ready to sell: row level security, the touch and audit triggers, the rules the database
-- keeps, the retail wording for existing retail businesses and the new permission keys for the roles
-- businesses already have. See docs/DATA_MODEL.md §6 and D-117, D-146–D-150.
--
-- Rules as in catalog_security: every tenant table gets ENABLE + FORCE RLS and the one standard policy
-- (app.apply_tenant_rls), touch_row BEFORE UPDATE and audit_row AFTER INSERT/UPDATE/DELETE. The grants
-- come from the default privileges of schema app. The API never deletes these rows: a recipe keeps
-- its row, and lines taken out of it are soft-deleted. Functions as in purchasing_integrity: SET
-- search_path = '' with schema-qualified names, owner postgres, EXECUTE revoked from
-- PUBLIC/anon/authenticated.

----------------------------------------------------------------------------------------------------
-- Row level security and row triggers
----------------------------------------------------------------------------------------------------

select app.apply_tenant_rls('app.recipes');
select app.apply_tenant_rls('app.recipe_lines');

create trigger touch_row before update on app.recipes
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.recipes
  for each row execute function app.audit_row();

create trigger touch_row before update on app.recipe_lines
  for each row execute function app.touch_row();
create trigger audit_row after insert or update or delete on app.recipe_lines
  for each row execute function app.audit_row();

----------------------------------------------------------------------------------------------------
-- An item bought ready to sell keeps its material (D-117)
----------------------------------------------------------------------------------------------------

-- The product and its material are one item from the owner's view: the link is made when both are
-- created, in one transaction, and never changes (the API has no path that changes it; this refuses
-- any other).
create function app.products_keep_resale_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'product % keeps the material it is bought as', new.id
    using errcode = 'check_violation';
end
$$;

create trigger keep_resale_link before update of resale_material_id on app.products_services
  for each row when (new.resale_material_id is distinct from old.resale_material_id)
  execute function app.products_keep_resale_link();

----------------------------------------------------------------------------------------------------
-- A material keeps its dimension once recipes use it, as once it is in the ledger (D-145)
----------------------------------------------------------------------------------------------------

-- A recipe line's base quantity is in the material's base unit. The API refuses a change of dimension
-- while a live recipe line names the material (MATERIAL_IN_USE), under the material's row lock, and
-- a recipe save locks its materials FOR SHARE first; the trigger holds the same rule for any path.
create or replace function app.materials_keep_dimension()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A fresh snapshot (READ COMMITTED, a volatile function) taken after the row lock: movements and
  -- recipe lines committed while this update waited for the row are counted.
  if exists (
    select 1 from app.stock_movements m
    where m.business_id = new.business_id and m.material_id = new.id
  ) or exists (
    select 1 from app.recipe_lines l
    where l.business_id = new.business_id and l.material_id = new.id and l.deleted_at is null
  ) then
    raise exception 'material % is in the stock ledger or a recipe: its kind of measure cannot change',
      new.id
      using errcode = 'BZ423';
  end if;
  return new;
end
$$;

----------------------------------------------------------------------------------------------------
-- Ownership and grants
----------------------------------------------------------------------------------------------------

alter function app.products_keep_resale_link() owner to postgres;
alter function app.materials_keep_dimension() owner to postgres;

revoke all on function app.products_keep_resale_link() from public, anon, authenticated;
revoke all on function app.materials_keep_dimension() from public, anon, authenticated;
grant execute on function app.products_keep_resale_link() to bizcost_api;
grant execute on function app.materials_keep_dimension() to bizcost_api;

----------------------------------------------------------------------------------------------------
-- The retail wording for existing retail businesses (D-117)
----------------------------------------------------------------------------------------------------

-- Smart Setup gives the business type `retail` the terminology profile `retail` from now on
-- (PRODUCT.md §6.4 row 7); retail businesses made before got `general`. Only local and demo data
-- exist. A profile the owner could have changed stays (none can today: it follows the type).
update app.businesses
set terminology_profile = 'retail'
where business_type = 'retail'
  and terminology_profile = 'general';

----------------------------------------------------------------------------------------------------
-- New permission keys for existing template roles (D-124, D-149)
----------------------------------------------------------------------------------------------------

-- Recipes are part of Products & Services: "see what goes into each product" and "change it". Smart
-- Setup copies the role templates of @bizcost/modules (role-templates.ts) into every new business;
-- the roles businesses already have get the same new keys here, once (as catalog_security and
-- purchasing_security did). The pairs below must equal the templates' new keys (docs/PRODUCT.md §8).
-- Every member holding a changed role gets a new permissions_version, so open apps reload their
-- access.
with defaults (template_key, permission_key) as (
  values
    ('admin', 'products.recipes.view'),
    ('admin', 'products.recipes.manage'),
    ('manager', 'products.recipes.view'),
    ('manager', 'products.recipes.manage'),
    ('accountant', 'products.recipes.view'),
    ('supervisor', 'products.recipes.view')
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
