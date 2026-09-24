import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'
import plugin from './plugin.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-physical-direction-classes', plugin.rules['no-physical-direction-classes'], {
  valid: [
    { code: `const c = 'ms-2 pe-4 text-start rounded-s-lg border-e start-0'` },
    { code: `const c = 'flex items-center gap-2'` },
    { code: `const label = 'Turn left at the shop'` },
    { code: 'const c = `ps-${n} me-2`' },
  ],
  invalid: [
    { code: `const c = 'ml-2'`, errors: [{ messageId: 'physical' }] },
    { code: `const c = 'flex pr-4'`, errors: [{ messageId: 'physical' }] },
    { code: `const c = 'md:text-left'`, errors: [{ messageId: 'physical' }] },
    { code: `const c = 'absolute -left-2'`, errors: [{ messageId: 'physical' }] },
    { code: `const c = 'rounded-r-lg border-l'`, errors: [{ messageId: 'physical' }] },
    { code: 'const c = `gap-2 mr-${n}`', errors: [{ messageId: 'physical' }] },
    { code: `const el = <div className="p-2 right-0" />`, errors: [{ messageId: 'physical' }] },
  ],
})

tester.run('no-physical-style-props', plugin.rules['no-physical-style-props'], {
  valid: [{ code: `const s = { marginStart: 8, paddingEnd: 4, start: 0, textAlign: 'center' }` }],
  invalid: [
    { code: `const s = { marginLeft: 8 }`, errors: [{ messageId: 'physical' }] },
    { code: `const s = { right: 0, paddingRight: 2 }`, errors: 2 },
    { code: `const s = { textAlign: 'left' }`, errors: [{ messageId: 'textAlign' }] },
  ],
})

tester.run('no-raw-set', plugin.rules['no-raw-set'], {
  valid: [
    { code: 'tx.execute(sql`select * from app.locations where id = ${id}`)' },
    { code: 'sql`update app.locations set name = ${name} where id = ${id}`' },
    { code: `const label = 'Set up your business'` },
    { code: `t('settings.reset')` },
  ],
  invalid: [
    {
      code: 'tx.execute(sql`set app.business_id = ${id}`)',
      errors: [{ messageId: 'rawSet' }],
    },
    { code: 'sql`  SET LOCAL ROLE postgres`', errors: [{ messageId: 'rawSet' }] },
    { code: 'sql`reset app.user_id`', errors: [{ messageId: 'rawSet' }] },
    {
      code: "sql`select set_config('app.business_id', ${id}, false)`",
      errors: [{ messageId: 'rawSet' }],
    },
    { code: "sql.raw('set search_path = public')", errors: [{ messageId: 'rawSet' }] },
    { code: "client.unsafe('set role bizcost_api')", errors: [{ messageId: 'rawSet' }] },
    { code: 'db.execute(`reset all`)', errors: [{ messageId: 'rawSet' }] },
  ],
})
