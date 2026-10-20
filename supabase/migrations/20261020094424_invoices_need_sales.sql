-- BizCost: Release B review (M3 Step 9): Invoices needs Sales.
--
-- An issued invoice posts a sale and a credit note a negative one, Sales lists them, an invoice names
-- a sales channel and may bill a recorded One sale, so the Invoices manifest now depends on Sales
-- (as Orders does since Release A): Customize BizCost turns Invoices off with Sales and Sales on with
-- Invoices. A business that switched Sales off while Smart Setup had turned Invoices on keeps a state
-- Customize can no longer reach; Invoices goes off for it here, as Customize would have done (nothing
-- is deleted: turning Invoices on again turns Sales on with it).
--
-- Sales is a core module: on unless its row says off. Every member of such a business then gets a new
-- permissions_version, so open apps read business.context again.

with turned as (
  update app.business_modules i
     set enabled = false, enabled_at = now()
   where i.module_key = 'invoices'
     and i.enabled
     and i.deleted_at is null
     and exists (
       select 1 from app.business_modules s
        where s.business_id = i.business_id
          and s.module_key = 'sales'
          and not s.enabled
          and s.deleted_at is null)
  returning i.business_id
)
update app.business_members m
set permissions_version = m.permissions_version + 1
where m.deleted_at is null
  and m.business_id in (select business_id from turned);
