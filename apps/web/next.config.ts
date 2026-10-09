import type { NextConfig } from 'next'

const config: NextConfig = {
  // The dashboard package ships TypeScript source; Next compiles it with the app.
  transpilePackages: ['@ejc3/claude-master-dashboard'],
  poweredByHeader: false,
}

export default config
