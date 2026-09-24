import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// The package-boundary rules of index.js, checked through the repo's real flat config: layer order
// domain → contracts → modules → db → api, and the API's single database entry (ctx.tenantTx).

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const eslint = new ESLint({ cwd: repoRoot })

async function restrictedImports(file, code) {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, file) })
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').length
}

describe('layer order', () => {
  it.each([
    ['packages/domain/src/probe.ts', '@bizcost/contracts'],
    ['packages/domain/src/probe.ts', '@bizcost/modules'],
    ['packages/contracts/src/probe.ts', '@bizcost/modules'],
    ['packages/modules/src/probe.ts', '@bizcost/db'],
    ['packages/db/src/probe.ts', '@bizcost/api'],
  ])('%s may not import %s', async (file, source) => {
    const code = `import { x } from '${source}'\nexport { x }\n`
    expect(await restrictedImports(file, code)).toBeGreaterThan(0)
  })

  it.each([
    ['packages/contracts/src/probe.ts', '@bizcost/domain'],
    ['packages/modules/src/probe.ts', '@bizcost/contracts'],
    ['packages/db/src/probe.ts', '@bizcost/domain'],
    ['packages/api/src/probe.ts', '@bizcost/modules'],
  ])('%s may import %s', async (file, source) => {
    expect(await restrictedImports(file, `import { x } from '${source}'\nexport { x }\n`)).toBe(0)
  })

  it('keeps the pure-package rules in layer packages', async () => {
    const code = `import { x } from 'drizzle-orm'\nexport { x }\n`
    expect(await restrictedImports('packages/modules/src/probe.ts', code)).toBe(1)
  })
})

describe('database entry in the API', () => {
  const code = `import { withTenantTx, createDb, profiles } from '@bizcost/db'\nexport { withTenantTx, createDb, profiles }\n`

  it('bans withTenantTx and createDb in procedures and helpers', async () => {
    expect(await restrictedImports('packages/api/src/routers/probe.ts', code)).toBe(2)
    expect(await restrictedImports('packages/api/src/services/probe.ts', code)).toBe(2)
  })

  it('allows them where the context is built and in tests', async () => {
    expect(await restrictedImports('packages/api/src/context.ts', code)).toBe(0)
    expect(await restrictedImports('packages/api/test/probe.api.test.ts', code)).toBe(0)
  })
})
