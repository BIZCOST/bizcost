-- pgTAP: catalog coverage for schema app (Milestone 1, Step 1).
-- Structural rules from docs/DATA_MODEL.md sections 1-4 and the Step 1 decisions:
-- RLS on every table, the one standard tenant policy, identity-table policies,
-- tenantTable() columns/keys, composite FKs, no FK into auth, indexes led by
-- business_id, and the touch/audit/owner triggers. Checks are catalog-driven,
-- so a new tenant table is covered without editing this file.
begin;
select plan(38);

-- Tables of schema app, and the subset carrying business_id.
create temp view app_tables as
  select c.oid as relid, c.relname::text as table_name, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
   where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
     and c.relkind in ('r', 'p');

create temp view business_tables as
  select t.*, a.attnum as business_id_attnum
    from app_tables t
    join pg_attribute a on a.attrelid = t.relid and a.attname = 'business_id' and not a.attisdropped;

-- Declared with tenantTable(): every business table except the append-only audit_log.
create temp view tenant_tables as
  select * from business_tables where table_name <> 'audit_log';

-- 1. Inventory ---------------------------------------------------------------

select has_schema('app', 'schema app exists');

select tables_are(
  'app',
  array[
    'profiles', 'businesses', 'business_capabilities', 'business_modules', 'locations',
    'roles', 'role_permissions', 'business_members', 'member_permission_overrides',
    'member_locations', 'business_invitations', 'setup_answers', 'audit_log'
  ],
  'app contains exactly the Milestone 1 tables'
);

select is(
  (select count(*)::int from business_tables),
  11,
  'sanity: 11 app tables carry business_id (the checks below are not vacuous)'
);

-- 2. Row level security ---------------------------------------------------------

select is_empty(
  $$ select table_name from app_tables where not relrowsecurity $$,
  'every app table has row level security enabled'
);

select is_empty(
  $$ select table_name from app_tables where not relforcerowsecurity $$,
  'every app table forces row level security, also for the table owner'
);

select is_empty(
  $$ select t.table_name
       from business_tables t
      where not exists (
          select 1 from pg_policy p where p.polrelid = t.relid and p.polname = 'tenant_isolation') $$,
  'every table with business_id has the tenant_isolation policy (ARCHITECTURE.md: FORCE RLS + the standard policy)'
);

select is_empty(
  $$ select t.table_name, p.polname
       from business_tables t
       join pg_policy p on p.polrelid = t.relid
      where t.table_name <> 'business_members'
        and p.polname <> 'tenant_isolation' $$,
  'those tables have no other policy (a second permissive policy would widen access)'
);

select is_empty(
  $$ select t.table_name
       from business_tables t
       join pg_policy p on p.polrelid = t.relid and p.polname = 'tenant_isolation'
      where p.polcmd <> '*'
         or not p.polpermissive
         or p.polroles <> array[(select oid from pg_roles where rolname = 'bizcost_api')] $$,
  'tenant_isolation is a permissive FOR ALL policy that applies to bizcost_api only'
);

select is_empty(
  $$ select tablename, qual, with_check
       from pg_policies
      where schemaname = 'app'
        and policyname = 'tenant_isolation'
        and not (
              strpos(coalesce(qual, ''), 'business_id = ( SELECT app.current_business_id()') > 0
          and strpos(coalesce(qual, ''), '( SELECT app.is_active_member(app.current_business_id())') > 0
          and coalesce(qual, '') !~ 'is_active_member\(business_id'
          and coalesce(with_check, qual) = qual) $$,
  'tenant_isolation uses the InitPlan predicate (no row column passed to a function) for USING and WITH CHECK'
);

select is_empty(
  $$ select c.relname, p.polname
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
      where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
        and p.polroles <> array[(select oid from pg_roles where rolname = 'bizcost_api')] $$,
  'every policy in app applies to bizcost_api only (none to PUBLIC, anon or authenticated)'
);

-- 3. Identity tables --------------------------------------------------------------

select is_empty(
  $$ select cmd
       from unnest(array['r', 'a', 'w', 'd']) as cmd
      where not exists (
        select 1 from pg_policy p
         where p.polrelid = to_regclass('app.business_members')
           and p.polcmd::text in (cmd, '*')) $$,
  'business_members has policies covering SELECT, INSERT, UPDATE and DELETE'
);

select is_empty(
  $$ select policyname
       from pg_policies
      where schemaname = 'app'
        and tablename = 'business_members'
        and strpos(coalesce(qual, '') || coalesce(with_check, ''),
                   '( SELECT app.is_active_member(app.current_business_id())') = 0 $$,
  'every business_members policy includes the standard tenant predicate'
);

select is_empty(
  $$ select policyname, cmd
       from pg_policies
      where schemaname = 'app'
        and tablename = 'business_members'
        and cmd <> 'SELECT'
        and strpos(coalesce(qual, '') || coalesce(with_check, ''), 'current_user_id') > 0 $$,
  'only reads of business_members use the own-membership shortcut; writes stay tenant-scoped'
);

select is(
  (select string_agg(distinct polcmd::text, '' order by polcmd::text)
     from pg_policy where polrelid = to_regclass('app.businesses')),
  'rw',
  'businesses has only SELECT and UPDATE policies (rows are created by app.create_business)'
);

select is(
  (select string_agg(distinct polcmd::text, '' order by polcmd::text)
     from pg_policy where polrelid = to_regclass('app.profiles')),
  'arw',
  'profiles has SELECT, INSERT and UPDATE policies and no DELETE policy'
);

select is_empty(
  $$ select policyname
       from pg_policies
      where schemaname = 'app'
        and tablename = 'profiles'
        and strpos(coalesce(qual, '') || coalesce(with_check, ''),
                   'id = ( SELECT app.current_user_id()') = 0 $$,
  'every profiles policy is limited to the caller''s own row'
);

-- 4. tenantTable() shape ------------------------------------------------------------

select is_empty(
  $$ select t.table_name, s.col
       from tenant_tables t
      cross join (values
        ('id', 'uuid', true),
        ('business_id', 'uuid', true),
        ('created_by', 'uuid', true),
        ('created_at', 'timestamp with time zone', true),
        ('updated_by', 'uuid', false),
        ('updated_at', 'timestamp with time zone', true),
        ('deleted_at', 'timestamp with time zone', false),
        ('version', 'integer', true),
        ('request_hash', 'text', false)
      ) as s(col, typ, not_null)
      where not exists (
        select 1 from pg_attribute a
         where a.attrelid = t.relid
           and a.attname = s.col
           and not a.attisdropped
           and format_type(a.atttypid, a.atttypmod) = s.typ
           and a.attnotnull = s.not_null) $$,
  'every tenant table has the tenantTable() columns with the documented types and nullability'
);

select is_empty(
  $$ select t.table_name, s.col, pg_get_expr(d.adbin, d.adrelid) as column_default
       from tenant_tables t
      cross join (values ('id'), ('created_by'), ('created_at'), ('updated_at'), ('version')) as s(col)
       join pg_attribute a on a.attrelid = t.relid and a.attname = s.col
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where case s.col
              when 'id' then d.adbin is not null
              when 'created_by' then pg_get_expr(d.adbin, d.adrelid) is distinct from 'app.current_user_id()'
              when 'version' then pg_get_expr(d.adbin, d.adrelid) is distinct from '1'
              else d.adbin is null
            end $$,
  'defaults: id has none (client UUIDv7), created_by = app.current_user_id(), timestamps and version are set'
);

select is_empty(
  $$ select t.table_name
       from tenant_tables t
      where not exists (
        select 1 from pg_index i
         where i.indrelid = t.relid
           and i.indisunique
           and i.indpred is null
           and i.indnkeyatts = 2
           and i.indkey[0] = t.business_id_attnum
           and i.indkey[1] = (select a.attnum from pg_attribute a
                               where a.attrelid = t.relid and a.attname = 'id')) $$,
  'every tenant table has UNIQUE (business_id, id), the target of composite FKs'
);

select is_empty(
  $$ select t.table_name
       from tenant_tables t
      where not exists (
        select 1 from pg_constraint c
         where c.conrelid = t.relid
           and c.contype = 'f'
           and c.confrelid = to_regclass('app.businesses')
           and c.conkey = array[t.business_id_attnum]) $$,
  'every tenant table references app.businesses through business_id'
);

select is_empty(
  $$ select t.table_name
       from business_tables t
       join pg_attribute a on a.attrelid = t.relid and a.attnum = t.business_id_attnum
      where not a.attnotnull $$,
  'business_id is NOT NULL on every table that has it'
);

-- 5. Foreign keys ---------------------------------------------------------------------

select is_empty(
  $$ select v.child, v.col, v.parent
       from (values
         ('role_permissions', 'role_id', 'roles'),
         ('business_members', 'role_id', 'roles'),
         ('member_permission_overrides', 'member_id', 'business_members'),
         ('member_locations', 'member_id', 'business_members'),
         ('member_locations', 'location_id', 'locations'),
         ('business_invitations', 'role_id', 'roles')
       ) as v(child, col, parent)
      where not exists (
        select 1
          from pg_constraint c
         where c.contype = 'f'
           and c.conrelid = to_regclass('app.' || v.child)
           and c.confrelid = to_regclass('app.' || v.parent)
           and cardinality(c.conkey) = 2
           and c.conkey @> array[
                 (select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'business_id'),
                 (select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = v.col)]) $$,
  'child -> parent references are composite FKs on (business_id, <parent>_id)'
);

select is_empty(
  $$ select c.conrelid::regclass::text as child_table, c.conname
       from pg_constraint c
       join business_tables child on child.relid = c.conrelid
       join business_tables parent on parent.relid = c.confrelid
      where c.contype = 'f'
        and not exists (
          select 1 from generate_subscripts(c.conkey, 1) as k
           where c.conkey[k] = child.business_id_attnum
             and c.confkey[k] = parent.business_id_attnum) $$,
  'no FK between tenant tables skips business_id (cross-business links are impossible)'
);

select is_empty(
  $$ select c.conrelid::regclass::text as child_table, c.conname
       from pg_constraint c
      where c.contype = 'f'
        and c.connamespace = (select oid from pg_namespace where nspname = 'app')
        and c.confrelid in (
          select oid from pg_class
           where relnamespace = (select oid from pg_namespace where nspname = 'auth')) $$,
  'no app table has a foreign key into schema auth (account deletion never cascades)'
);

select is_empty(
  $$ select c.conrelid::regclass::text as child_table, c.conname, c.confrelid::regclass::text as parent_table
       from pg_constraint c
       join pg_class r on r.oid = c.confrelid
      where c.contype = 'f'
        and c.connamespace = (select oid from pg_namespace where nspname = 'app')
        and r.relnamespace <> c.connamespace $$,
  'foreign keys from app only point to app tables'
);

-- 6. Indexes ------------------------------------------------------------------------------

select is_empty(
  $$ select t.table_name, i.indexrelid::regclass::text as index_name
       from business_tables t
       join pg_index i on i.indrelid = t.relid
      where not i.indisprimary
        and i.indkey[0] <> t.business_id_attnum
        and not (t.table_name = 'business_invitations'
                 and i.indkey[0] = (select a.attnum from pg_attribute a
                                     where a.attrelid = t.relid and a.attname = 'token_hash'))
        and not (t.table_name = 'business_members'
                 and i.indkey[0] = (select a.attnum from pg_attribute a
                                     where a.attrelid = t.relid and a.attname = 'user_id')) $$,
  'every index on a tenant table leads with business_id (except global token_hash and per-user membership lookups)'
);

-- 7. Triggers ------------------------------------------------------------------------------
-- pg_trigger.tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 64 INSTEAD.

select is_empty(
  $$ select t.table_name
       from (select relid, table_name from tenant_tables
             union all
             select to_regclass('app.businesses')::oid, 'businesses') as t
      where not exists (
        select 1 from pg_trigger g
         where g.tgrelid = t.relid
           and not g.tgisinternal
           and g.tgfoid = to_regprocedure('app.touch_row()')
           and (g.tgtype::int & 1) = 1
           and (g.tgtype::int & 2) = 2
           and (g.tgtype::int & 16) = 16) $$,
  'businesses and every tenant table run app.touch_row() BEFORE UPDATE FOR EACH ROW'
);

select is_empty(
  $$ select t.table_name
       from (select relid, table_name from tenant_tables
             union all
             select to_regclass('app.businesses')::oid, 'businesses') as t
      where coalesce((
              select bit_or(g.tgtype::int & 28)
                from pg_trigger g
               where g.tgrelid = t.relid
                 and not g.tgisinternal
                 and g.tgfoid = to_regprocedure('app.audit_row()')
                 and (g.tgtype::int & 1) = 1
                 and (g.tgtype::int & 2) = 0
                 and (g.tgtype::int & 64) = 0), 0) <> 28 $$,
  'businesses and every tenant table run app.audit_row() AFTER INSERT, UPDATE and DELETE FOR EACH ROW'
);

select is_empty(
  $$ select tbl
       from unnest(array['business_members', 'roles', 'businesses']) as tbl
      where not exists (
        select 1 from pg_trigger g
         where g.tgrelid = to_regclass('app.' || tbl)
           and not g.tgisinternal
           and g.tgconstraint <> 0
           and g.tgfoid = to_regprocedure('app.enforce_active_owner()')
           and g.tgdeferrable
           and g.tginitdeferred) $$,
  'business_members, roles and businesses (restore) carry a DEFERRABLE INITIALLY DEFERRED constraint trigger (at least one active owner)'
);

-- 8. Documented columns ------------------------------------------------------------------

select is_empty(
  $$ select v.tbl, v.col
       from (values
         ('businesses', 'id'), ('businesses', 'legal_name'), ('businesses', 'legal_name_ar'),
         ('businesses', 'business_type'), ('businesses', 'terminology_profile'), ('businesses', 'country'),
         ('businesses', 'currency'), ('businesses', 'vat_registered'), ('businesses', 'trn'),
         ('businesses', 'timezone'), ('businesses', 'default_locale'), ('businesses', 'plan'),
         ('businesses', 'setup_completed_at'), ('businesses', 'logo_path'), ('businesses', 'created_by'),
         ('businesses', 'created_at'), ('businesses', 'updated_by'), ('businesses', 'updated_at'),
         ('businesses', 'deleted_at'), ('businesses', 'version'),
         ('business_capabilities', 'key'), ('business_capabilities', 'enabled'),
         ('business_capabilities', 'value'), ('business_capabilities', 'source'),
         ('business_modules', 'module_key'), ('business_modules', 'enabled'),
         ('business_modules', 'enabled_at'), ('business_modules', 'enabled_by'),
         ('locations', 'name'), ('locations', 'is_default'),
         ('roles', 'name'), ('roles', 'template_key'),
         ('role_permissions', 'role_id'), ('role_permissions', 'permission_key'),
         ('business_members', 'user_id'), ('business_members', 'kind'), ('business_members', 'display_name'),
         ('business_members', 'status'), ('business_members', 'role_id'),
         ('business_members', 'permissions_version'), ('business_members', 'pin_hash'),
         ('member_permission_overrides', 'member_id'), ('member_permission_overrides', 'permission_key'),
         ('member_permission_overrides', 'effect'),
         ('member_locations', 'member_id'), ('member_locations', 'location_id'),
         ('business_invitations', 'email'), ('business_invitations', 'token_hash'),
         ('business_invitations', 'expires_at'), ('business_invitations', 'status'),
         ('business_invitations', 'role_id'), ('business_invitations', 'overrides'),
         ('business_invitations', 'location_ids'), ('business_invitations', 'send_count'),
         ('business_invitations', 'last_sent_at'),
         ('setup_answers', 'question_set_version'), ('setup_answers', 'answers')
       ) as v(tbl, col)
      where not exists (
        select 1 from pg_attribute a
         where a.attrelid = to_regclass('app.' || v.tbl)
           and a.attname = v.col
           and a.attnum > 0
           and not a.attisdropped) $$,
  'every documented Milestone 1 column exists'
);

select hasnt_column('app', 'businesses', 'business_id', 'businesses is the tenant root and has no business_id');
select col_type_is('app', 'businesses', 'country', 'character(2)', 'businesses.country is char(2)');
select col_type_is('app', 'businesses', 'currency', 'character(3)', 'businesses.currency is char(3)');
select col_type_is('app', 'business_invitations', 'email', 'extensions', 'citext', 'business_invitations.email is extensions.citext');
select col_type_is('app', 'business_invitations', 'location_ids', 'uuid[]', 'business_invitations.location_ids is uuid[]');
select col_not_null('app', 'business_members', 'display_name', 'business_members.display_name is NOT NULL for every kind');

select columns_are(
  'app', 'audit_log',
  array['id', 'business_id', 'actor_user_id', 'action', 'entity', 'entity_id', 'request_id', 'changes', 'created_at'],
  'audit_log has only the append-only columns (no updated_*, deleted_at, version)'
);

select columns_are(
  'app', 'profiles',
  array['id', 'display_name', 'locale', 'last_business_id', 'anonymized_at', 'created_at', 'updated_at'],
  'profiles has exactly the documented columns'
);

select * from finish();
rollback;
