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
}

export default nextConfig
