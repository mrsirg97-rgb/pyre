import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  env: {
    TORCH_NETWORK: process.env.TORCH_NETWORK || '',
  },
}

export default nextConfig
