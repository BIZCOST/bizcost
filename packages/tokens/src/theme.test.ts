import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderNativeCss, renderWebCss } from './render.ts'
import { COLOR_NAMES, colors, radius, THEMES, type ColorName, type ThemeName } from './tokens.ts'

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const webCss = read('theme.web.css')
const nativeCss = read('theme.native.css')

/** Body of the first block that starts with `header {` (brace-matched, nested blocks included). */
function block(css: string, header: string): string {
  const start = css.indexOf(`${header} {`)
  if (start < 0) throw new Error(`no block ${header}`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i)
  }
  throw new Error(`unclosed block ${header}`)
}

function variables(body: string, prefix = ''): Map<string, string> {
  const vars = new Map<string, string>()
  for (const [, name, value] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    if (name!.startsWith(prefix)) vars.set(name!.slice(prefix.length), value!.trim())
  }
  return vars
}

const sorted = (names: Iterable<string>) => [...names].sort()

describe('generated theme files', () => {
  it('are up to date with tokens.ts (run `pnpm --filter @bizcost/tokens generate`)', () => {
    expect(webCss).toBe(renderWebCss())
    expect(nativeCss).toBe(renderNativeCss())
  })

  it('define the same colors in both files and both themes', () => {
    const expected = sorted(COLOR_NAMES)
    const webLight = variables(block(webCss, ':root'))
    const webDark = variables(block(webCss, '.dark'))
    const webUtilities = variables(block(webCss, '@theme inline'), 'color-')
    const native = block(block(nativeCss, '@layer theme'), ':root')
    const nativeLight = variables(block(native, '@variant light'), 'color-')
    const nativeDark = variables(block(native, '@variant dark'), 'color-')

    for (const vars of [webDark, webUtilities, nativeLight, nativeDark]) {
      expect(sorted(vars.keys())).toEqual(expected)
    }
    expect(sorted(webLight.keys()).filter((n) => !/^(radius|font-)/.test(n))).toEqual(expected)
    for (const name of COLOR_NAMES) {
      expect(webUtilities.get(name)).toBe(`var(--${name})`)
      expect(webLight.get(name)).toBe(nativeLight.get(name))
      expect(webDark.get(name)).toBe(nativeDark.get(name))
    }
  })

  it('define the same radii in both files', () => {
    const expected = sorted(Object.keys(radius))
    const web = variables(block(webCss, '@theme inline'), 'radius-')
    const native = variables(block(nativeCss, '@theme'), 'radius-')
    expect(sorted(web.keys())).toEqual(expected)
    expect(Object.fromEntries(native)).toEqual(Object.fromEntries(web))
  })

  it('map font-sans to the IBM Plex families, Arabic first on Arabic pages', () => {
    expect(variables(block(webCss, '@theme inline')).get('font-sans')).toBe('var(--font-app)')
    expect(variables(block(webCss, ':root')).get('font-app')).toMatch(
      /^var\(--font-latin\), var\(--font-arabic\)/,
    )
    expect(variables(block(webCss, ':root:lang(ar)')).get('font-app')).toMatch(
      /^var\(--font-arabic\), var\(--font-latin\)/,
    )
  })
})

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// [text, surface]: normal text needs 4.5:1 (AA).
const TEXT_PAIRS: [ColorName, ColorName][] = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['destructive-foreground', 'destructive'],
  ['brand-foreground', 'brand'],
  ['profit-foreground', 'profit'],
  ['loss-foreground', 'loss'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['info-foreground', 'info'],
  // Colored text straight on a card or the page (amounts, links, error messages).
  ['primary', 'card'],
  ['primary', 'background'],
  ['destructive', 'card'],
  ['destructive', 'background'],
  ['profit', 'card'],
  ['loss', 'card'],
  ['warning', 'card'],
  ['info', 'card'],
]

// [element, surface]: focus rings and input borders need 3:1 (WCAG 1.4.11).
const UI_PAIRS: [ColorName, ColorName][] = [
  ['ring', 'background'],
  ['ring', 'card'],
  ['input', 'card'],
  ['input', 'background'],
]

describe.each(THEMES)('%s theme contrast', (theme: ThemeName) => {
  const palette = colors[theme]

  it.each(TEXT_PAIRS)('%s on %s is at least 4.5:1', (text, surface) => {
    expect(contrast(palette[text], palette[surface])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(UI_PAIRS)('%s on %s is at least 3:1', (element, surface) => {
    expect(contrast(palette[element], palette[surface])).toBeGreaterThanOrEqual(3)
  })

  it('uses 6-digit hex colors only (web and native parse the same values)', () => {
    for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })
})
