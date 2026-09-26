import {
  COLOR_NAMES,
  THEMES,
  tokens as defaultTokens,
  type Palette,
  type Tokens,
} from './tokens.ts'

// Renders the two theme files from the tokens. The output is already Prettier-formatted, so the
// generated files pass `pnpm format:check` unchanged.

const HEADER =
  '/* Generated from packages/tokens/src/tokens.ts by `pnpm --filter @bizcost/tokens generate`. Do not edit. */'

type Script = 'latin' | 'arabic'

function declarations(entries: readonly (readonly [string, string])[], indent: string): string {
  return entries.map(([name, value]) => `${indent}--${name}: ${value};`).join('\n')
}

function paletteEntries(palette: Palette, prefix = ''): [string, string][] {
  return COLOR_NAMES.map((name) => [`${prefix}${name}`, palette[name]])
}

function radiusEntries(radius: Tokens['radius']): [string, string][] {
  return Object.entries(radius).map(([name, value]) => [`radius-${name}`, value])
}

/** The next/font variable, with the family name as a fallback when the variable is not set. */
function fontFamily(fonts: Tokens['fonts'], script: Script): string {
  return `var(${fonts[script].cssVariable}, '${fonts[script].family}')`
}

/**
 * Arabic pages put the Arabic family first; other glyphs fall back to the second family. The first
 * family's variable must hold the family alone (the web's Latin face has no metric fallback), or the
 * fallback would draw the other script before the second family is tried.
 */
function fontStack(fonts: Tokens['fonts'], first: Script): string {
  const order: Script[] = first === 'latin' ? ['latin', 'arabic'] : ['arabic', 'latin']
  return [...order.map((script) => `var(--font-${script})`), ...fonts.fallback].join(', ')
}

/**
 * theme.web.css: shadcn/ui variables on `:root` (light) and `.dark`, mapped to Tailwind v4 utilities
 * with `@theme inline` (bg-primary, text-profit, rounded-lg, font-sans, …).
 */
export function renderWebCss(tokens: Tokens = defaultTokens): string {
  const { colors, radius, fonts } = tokens
  return [
    HEADER,
    '',
    '@custom-variant dark (&:where(.dark, .dark *));',
    '',
    ':root {',
    '  color-scheme: light;',
    `  --radius: ${radius.lg};`,
    `  --font-latin: ${fontFamily(fonts, 'latin')};`,
    `  --font-arabic: ${fontFamily(fonts, 'arabic')};`,
    `  --font-app: ${fontStack(fonts, 'latin')};`,
    declarations(paletteEntries(colors.light), '  '),
    '}',
    '',
    ':root:lang(ar) {',
    `  --font-app: ${fontStack(fonts, 'arabic')};`,
    '}',
    '',
    '.dark {',
    '  color-scheme: dark;',
    declarations(paletteEntries(colors.dark), '  '),
    '}',
    '',
    '@theme inline {',
    declarations(
      COLOR_NAMES.map((name) => [`color-${name}`, `var(--${name})`]),
      '  ',
    ),
    declarations(radiusEntries(radius), '  '),
    '  --font-sans: var(--font-app);',
    '}',
    '',
  ].join('\n')
}

/**
 * theme.native.css: Uniwind themes. Every theme defines the same `--color-*` variables inside
 * `@layer theme { :root { @variant <theme> { … } } }`; non-themed tokens go in `@theme`.
 */
export function renderNativeCss(tokens: Tokens = defaultTokens): string {
  const { colors, radius } = tokens
  return [
    HEADER,
    '',
    '@theme {',
    declarations(radiusEntries(radius), '  '),
    '}',
    '',
    '@layer theme {',
    '  :root {',
    THEMES.map((theme) =>
      [
        `    @variant ${theme} {`,
        declarations(paletteEntries(colors[theme], 'color-'), '      '),
        '    }',
      ].join('\n'),
    ).join('\n\n'),
    '  }',
    '}',
    '',
  ].join('\n')
}
