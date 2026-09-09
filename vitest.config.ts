import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // openclaw SDK 只在 gateway 运行时可解析；测试里换成身份包装替身，
      // 让 clickin-memory 插件可以被 import 并用 fake api 做集成测试
      "openclaw/plugin-sdk/plugin-entry": path.resolve(__dirname, "tests/mocks/openclaw-plugin-entry.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // .next/standalone 里有构建时拷贝的旧测试文件，不能当真测试跑
    exclude: [...configDefaults.exclude, ".next/**"],
    testTimeout: 15000,
    // 测试库上的 statement_timeout 放宽到 60s（#459）：migration 测试是**整个
    // .sql 文件一条 query** 打进去的，生产的 15s 阈值是按单条业务语句定的，不适用。
    // 不设 0——超时闸在测试里也该是活的（单条测试另有 testTimeout 兜底）。
    env: { PG_STATEMENT_TIMEOUT_MS: "60000" },
    globalSetup: "./tests/global-setup.ts",
    setupFiles: ["./tests/setup.ts"],
    // All test files share one DB — parallel execution causes cross-file membership pollution
    fileParallelism: false,
  },
});
