import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: '/app',
  env: { NEXT_PUBLIC_BASE_PATH: '/app' },
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
