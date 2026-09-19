import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  output: 'standalone',
  // #553 「我的权限」页已下线（无导航入口、读的是死字段 isAdmin）；旧链接温柔落回首页。
  async redirects() {
    return [{ source: '/my/permissions', destination: '/', permanent: true }];
  },
  // #47 pdf 解析：pdfjs 的 cmaps/standard_fonts 是运行时按需读的数据文件，
  // 不会被依赖追踪自动带进 standalone——缺 cMaps 时 CJK pdf 整页静默蒸发
  // （わが星实测），必须显式圈进来。
  outputFileTracingIncludes: {
    '/**/*': [
      './node_modules/pdfjs-dist/cmaps/**',
      './node_modules/pdfjs-dist/standard_fonts/**',
      './node_modules/pdfjs-dist/wasm/**',
      './node_modules/pdfjs-dist/iccs/**',
      // #531 使用手册：content/manual 由 lib/help/manual.ts 运行时 fs 直读，同样不会被追踪
      './content/manual/**',
    ],
  },
};

export default nextConfig;
