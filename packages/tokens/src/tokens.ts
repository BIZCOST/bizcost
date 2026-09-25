// Design tokens: the single source for web (Tailwind v4 + shadcn/ui) and mobile (Uniwind).
// `pnpm --filter @bizcost/tokens generate` writes theme.web.css and theme.native.css from this file;
// a test fails when they are out of date (docs/ARCHITECTURE.md §Styling).
//
// Brand blues are sampled from the BizCost logo in docs/mockups: `primary` is the logo blue of the app
// screens, `brand` the deeper blue of the large logo. Profit green and loss red come from the same
// mockups, adjusted so that text on them (and they as text on the page) meets WCAG AA contrast.

export type Hex = `#${string}`

export const THEMES = ['light', 'dark'] as const
export type ThemeName = (typeof THEMES)[number]

/** Color names, in shadcn/ui naming plus BizCost's semantic colors. */
export const COLOR_NAMES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'brand',
  'brand-foreground',
  'profit',
  'profit-foreground',
  'loss',
  'loss-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
] as const
export type ColorName = (typeof COLOR_NAMES)[number]

export type Palette = Readonly<Record<ColorName, Hex>>

const light: Palette = {
  background: '#f5f7fa',
  foreground: '#101828',
  card: '#ffffff',
  'card-foreground': '#101828',
  popover: '#ffffff',
  'popover-foreground': '#101828',
  primary: '#1668c2',
  'primary-foreground': '#ffffff',
  secondary: '#eef3fa',
  'secondary-foreground': '#12305a',
  muted: '#eef1f5',
  'muted-foreground': '#5b6676',
  accent: '#e8f0fb',
  'accent-foreground': '#0f3f75',
  destructive: '#c62f3a',
  'destructive-foreground': '#ffffff',
  border: '#e1e6ed',
  input: '#808b9e',
  ring: '#1668c2',
  brand: '#0b4f8f',
  'brand-foreground': '#ffffff',
  profit: '#0b7f5b',
  'profit-foreground': '#ffffff',
  loss: '#c62f3a',
  'loss-foreground': '#ffffff',
  success: '#0b7f5b',
  'success-foreground': '#ffffff',
  warning: '#a85a07',
  'warning-foreground': '#ffffff',
  info: '#0a74b0',
  'info-foreground': '#ffffff',
  'chart-1': '#2f80d1',
  'chart-2': '#18a06b',
  'chart-3': '#f2b01e',
  'chart-4': '#e0443e',
  'chart-5': '#7b5cd6',
  'chart-6': '#1f3a5f',
}

const dark: Palette = {
  background: '#0b1220',
  foreground: '#e6edf6',
  card: '#111a2b',
  'card-foreground': '#e6edf6',
  popover: '#111a2b',
  'popover-foreground': '#e6edf6',
  primary: '#5aa2ee',
  'primary-foreground': '#08203d',
  secondary: '#1a2638',
  'secondary-foreground': '#e6edf6',
  muted: '#172233',
  'muted-foreground': '#9aa8bb',
  accent: '#1c2b42',
  'accent-foreground': '#e6edf6',
  destructive: '#f0606b',
  'destructive-foreground': '#1f0306',
  border: '#223047',
  input: '#617189',
  ring: '#5aa2ee',
  brand: '#0e3f72',
  'brand-foreground': '#ffffff',
  profit: '#34c790',
  'profit-foreground': '#04241a',
  loss: '#f0606b',
  'loss-foreground': '#1f0306',
  success: '#34c790',
  'success-foreground': '#04241a',
  warning: '#f2a33a',
  'warning-foreground': '#2b1700',
  info: '#4db3e6',
  'info-foreground': '#03202f',
  'chart-1': '#5aa2ee',
  'chart-2': '#34c790',
  'chart-3': '#f5c04a',
  'chart-4': '#f0606b',
  'chart-5': '#a08bf0',
  'chart-6': '#8ea3bf',
}

export const colors: Readonly<Record<ThemeName, Palette>> = { light, dark }

/** Corner radii. `lg` is the base radius of cards and inputs (shadcn `--radius`). */
export const radius = {
  sm: '0.375rem',
  md: '0.5rem',
  lg: '0.625rem',
  xl: '0.875rem',
} as const
export type RadiusName = keyof typeof radius

/**
 * Font families. On web, next/font sets the two CSS variables on <html>; Arabic pages put the
 * Arabic family first (theme.web.css). Mobile font loading is set up with the Expo app.
 */
export const fonts = {
  latin: { family: 'IBM Plex Sans', cssVariable: '--font-plex-sans' },
  arabic: { family: 'IBM Plex Sans Arabic', cssVariable: '--font-plex-sans-arabic' },
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
} as const

export const tokens = { colors, radius, fonts } as const
export type Tokens = typeof tokens
