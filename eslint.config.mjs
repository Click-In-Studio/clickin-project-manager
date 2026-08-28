import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".marker-test-dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // OpenClaw gateway 侧插件：SDK 依赖只在 gateway 运行时可解析，不参与本仓库构建
    "openclaw-plugins/**",
    // 上游 vendor 源码（#367，纪律见 vendor/openclaw/VENDOR.md）：按上游风格原样保留，
    // 不套本仓库 lint；本地改动只允许出现在 VENDOR.md 登记的补丁里
    "vendor/**",
  ]),
  {
    // Disable experimental React Compiler rules that produce false positives
    // for valid React patterns (ref sync in render, setState in useEffect, etc.).
    // These are part of eslint-plugin-react-compiler bundled with Next.js 16
    // and are not yet stable.
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
]);

export default eslintConfig;
