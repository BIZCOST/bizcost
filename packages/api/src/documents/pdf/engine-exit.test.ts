import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The PDF engine's worker is held while it works and let go when idle (Release B review): a script
// that renders documents (`pnpm demo:seed`) ends once its last one is done, and is never cut short
// while one renders. Before, a 'message' listener held the worker for good and the seed never ended.

const ENGINE = new URL('./engine.ts', import.meta.url).href
const LOGO = fileURLToPath(new URL('../../../scripts/samples/images/logo.png', import.meta.url))

describe('a script that uses the PDF engine', () => {
  it('ends after its jobs, with the jobs done', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bizcost-engine-'))
    const file = join(dir, 'probe.mts')
    writeFileSync(
      file,
      [
        `import { readFileSync } from 'node:fs'`,
        `import { pdfEngine } from ${JSON.stringify(ENGINE)}`,
        `const bytes = new Uint8Array(readFileSync(${JSON.stringify(LOGO)}))`,
        `const first = await pdfEngine().probe({ path: '/img/logo.png', bytes })`,
        `const second = await pdfEngine().probe({ path: '/img/logo.png', bytes })`,
        `console.log('probed', first.ok, second.ok)`,
      ].join('\n'),
    )
    try {
      const run = spawnSync(
        process.execPath,
        ['--conditions=react-server', '--import', 'tsx', file],
        { encoding: 'utf8', timeout: 60_000 },
      )
      // A worker that keeps the process alive ends in the timeout (an error, no status).
      expect(run.error, run.stderr).toBeUndefined()
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain('probed true true')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 70_000)
})
