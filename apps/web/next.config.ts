import type { NextConfig } from 'next'

// Security headers on every response (docs/ARCHITECTURE.md §Network exposure): no framing by any site
// (clickjacking), HTTPS only (browsers ignore HSTS on plain-http localhost), no MIME sniffing, and no
// full URLs in the Referer header of cross-site requests.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
]

// The web app (UI + the API at /api/trpc). Workspace packages ship TypeScript source.
const nextConfig: NextConfig = {
  // The repo keeps its own agent instructions (CLAUDE.md, docs/); next dev must not write any.
  agentRules: false,
  poweredByHeader: false,
  // E2E runs its own server in a separate build folder, next to a developer's `next dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: [
    '@bizcost/api',
    '@bizcost/app-core',
    '@bizcost/contracts',
    '@bizcost/db',
    '@bizcost/domain',
    '@bizcost/i18n',
    '@bizcost/modules',
    '@bizcost/tokens',
  ],
  headers: async () => [{ source: '/:path*', headers: securityHeaders }],
  // The documents' PDFs (M3 Step 7, D-224) render in a worker thread of the API function, from files
  // the bundler never sees: the worker, the template and the four IBM Plex fonts are traced into the
  // function here. Turbopack's includes skip node_modules, so the Typst compiler and its WebAssembly get
  // there through packages/api/src/documents/pdf/deploy-trace.ts (D-353); CI renders from the trace alone.
  serverExternalPackages: ['@myriaddreamin/typst.ts', '@myriaddreamin/typst-ts-web-compiler'],
  outputFileTracingIncludes: {
    '/api/trpc/[trpc]': ['../../packages/api/src/documents/pdf/**/*'],
  },
}

export default nextConfig
