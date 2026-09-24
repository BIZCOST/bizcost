import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import bizcost from './plugin.js'

// Packages that must stay free of UI, framework and I/O code.
const PURE_PACKAGES = ['domain', 'contracts', 'modules', 'i18n', 'tokens'].map(
  (p) => `packages/${p}/**`,
)

const UI_AND_IO = [
  'react',
  'react-dom',
  'react-native',
  'next',
  'next/*',
  'expo',
  'expo-*',
  '@supabase/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'postgres',
]

const SERVER_PACKAGES = ['@bizcost/db', '@bizcost/db/*', '@bizcost/api', '@bizcost/api/*']

// Money and quantities are decimal strings / decimal.js — never JS floats (docs/ARCHITECTURE.md).
const NO_FLOAT_MONEY = [
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'Do not parse numbers as floats. Use the decimal helpers in @bizcost/domain.',
  },
  {
    selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
    message: 'Do not parse numbers as floats. Use the decimal helpers in @bizcost/domain.',
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: 'toFixed rounds binary floats. Use the rounding helpers in @bizcost/domain.',
  },
]

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/.expo/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    plugins: { bizcost },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // RTL: logical utilities only, everywhere UI code can live.
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/app-core/**/*.{ts,tsx}', 'packages/tokens/**/*.ts'],
    rules: { 'bizcost/no-physical-direction-classes': 'error' },
  },
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: { 'bizcost/no-physical-style-props': 'error' },
  },
  // No float money in code that handles amounts.
  {
    files: ['packages/**/*.ts', 'apps/**/*.{ts,tsx}'],
    ignores: ['packages/config/**'],
    rules: { 'no-restricted-syntax': ['error', ...NO_FLOAT_MONEY] },
  },
  // Package boundaries (dependency direction: domain ← contracts ← modules ← db ← api).
  {
    files: PURE_PACKAGES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...UI_AND_IO, ...SERVER_PACKAGES, '@bizcost/app-core', '@bizcost/app-core/*'],
              message: 'Pure packages must not import UI, framework, database or server code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/app-core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react-dom', 'react-native', 'next', 'next/*', 'expo', 'expo-*'],
              message: 'app-core is shared by web and mobile: no platform-specific imports.',
            },
            {
              group: SERVER_PACKAGES,
              allowTypeImports: true,
              message: 'app-core may only import types from server packages (e.g. AppRouter).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/**'],
    ignores: ['apps/web/app/api/trpc/**', 'apps/web/src/lib/trpc/server.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: SERVER_PACKAGES,
              allowTypeImports: true,
              message:
                'Apps talk to the API over tRPC; only the web API route may import server packages.',
            },
          ],
        },
      ],
    },
  },
  prettier,
)
