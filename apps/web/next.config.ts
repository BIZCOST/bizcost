import type { NextConfig } from 'next'

// Step 2: the web app only hosts the API (/api/trpc). Workspace packages ship TypeScript source.
const nextConfig: NextConfig = {
  transpilePackages: [
    '@bizcost/api',
    '@bizcost/contracts',
    '@bizcost/db',
    '@bizcost/domain',
    '@bizcost/modules',
  ],
}

export default nextConfig
