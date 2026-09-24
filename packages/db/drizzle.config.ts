import { defineConfig } from 'drizzle-kit'

// Generates SQL only. Migrations are applied exclusively by the Supabase CLI (`supabase db reset` locally,
// `supabase db push` from CI) — never drizzle-kit push/migrate (docs/DATA_MODEL.md §1.1).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema',
  out: '../../supabase/migrations',
  migrations: { prefix: 'supabase' },
  schemaFilter: ['app'],
})
