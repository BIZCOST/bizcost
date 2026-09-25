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
  'react-i18next',
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

// Layer order domain → contracts → modules → db → api (docs/ARCHITECTURE.md §Package dependency
// rules): a package imports only packages earlier in the chain.
const LAYERS = ['domain', 'contracts', 'modules', 'db', 'api']

const PURE_IMPORTS = {
  group: [...UI_AND_IO, ...SERVER_PACKAGES, '@bizcost/app-core', '@bizcost/app-core/*'],
  message: 'Pure packages must not import UI, framework, database or server code.',
}

const API_DB_ENTRY = {
  name: '@bizcost/db',
  importNames: ['createDb', 'withTenantTx'],
  message: 'Use ctx.tenantTx() / ctx.tx(): every data access runs as the caller.',
}

const API_ADMIN = {
  group: ['**/admin', '**/admin/*'],
  message: 'The Supabase Admin API (secret key) is for the account service only.',
}

function laterLayers(layer) {
  const later = LAYERS.slice(LAYERS.indexOf(layer) + 1)
  return {
    group: later.flatMap((name) => [`@bizcost/${name}`, `@bizcost/${name}/*`]),
    message: `Layer order is ${LAYERS.join(' → ')}: ${layer} may import only earlier layers.`,
  }
}

function restrictedImports(...patterns) {
  return { 'no-restricted-imports': ['error', { patterns }] }
}

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
  // Tenant context only through withTenantTx() (docs/ARCHITECTURE.md §Tenancy & security). Tests may
  // switch roles or run `set constraints` on purpose.
  {
    files: ['packages/**/*.ts', 'apps/**/*.{ts,tsx}'],
    ignores: [
      'packages/config/**',
      'packages/db/src/tenant.ts',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/test/**',
    ],
    rules: { 'bizcost/no-raw-set': 'error' },
  },
  // Package boundaries: pure packages, then the layer order (a later block replaces the rule's
  // options for its files, so each layer block repeats the pure-package patterns).
  { files: PURE_PACKAGES, rules: restrictedImports(PURE_IMPORTS) },
  ...['domain', 'contracts', 'modules'].map((layer) => ({
    files: [`packages/${layer}/**`],
    rules: restrictedImports(PURE_IMPORTS, laterLayers(layer)),
  })),
  { files: ['packages/db/**'], rules: restrictedImports(laterLayers('db')) },
  // The API reaches the database only through ctx.tenantTx / ctx.tx, which bind withTenantTx to the
  // verified caller and the request id (context.ts). The raw pool is never on the context.
  // The Supabase Admin API (secret key, packages/api/src/admin) is used by the account service only.
  {
    files: ['packages/api/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [API_DB_ENTRY], patterns: [API_ADMIN] }] },
  },
  {
    files: ['packages/api/src/context.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [API_ADMIN] }] },
  },
  {
    files: ['packages/api/src/services/account.ts', 'packages/api/src/admin/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [API_DB_ENTRY] }] },
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
  // i18n on web: one instance per request on the server (createI18n inside React cache()) and a new
  // instance for a new language in the browser. changeLanguage on a shared instance would leak one
  // request's language into another (docs/ARCHITECTURE.md §i18n & RTL).
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/api/**/*.ts', 'packages/i18n/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'changeLanguage',
          message: 'Create an instance for the locale with createI18n({ locale }) (@bizcost/i18n).',
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
