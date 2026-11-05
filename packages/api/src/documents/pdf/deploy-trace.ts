import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Never called. The PDF worker (worker.mjs) is started from a path, so the bundler does not see what it
 * loads, and Turbopack's outputFileTracingIncludes (next.config.ts) skips node_modules: without this,
 * the hosted API function has the worker and no compiler, and every PDF fails there while every local
 * run passes (D-353). These references are what put the two packages (kept external by
 * serverExternalPackages) and the compiler's WebAssembly into the function's trace. CI proves it: it
 * renders from the traced files alone (packages/config/ci/check-pdf-trace.mjs).
 */
export function deployTrace(): readonly unknown[] {
  return [
    import('@myriaddreamin/typst.ts'),
    import('@myriaddreamin/typst-ts-web-compiler'),
    readFileSync(
      join(
        process.cwd(),
        '../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
      ),
    ),
  ]
}
