// Writes theme.web.css and theme.native.css from src/tokens.ts. Run after changing a token:
// `pnpm --filter @bizcost/tokens generate` (a test fails while the files are out of date).
import { writeFileSync } from 'node:fs'
import { renderNativeCss, renderWebCss } from '../src/render.ts'

const root = new URL('../', import.meta.url)
writeFileSync(new URL('theme.web.css', root), renderWebCss())
writeFileSync(new URL('theme.native.css', root), renderNativeCss())
