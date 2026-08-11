import { faker } from "@faker-js/faker";
import os from "node:os";
import path from "node:path";

// Agent 记忆存储根指向进程专属临时目录：MEMORY_ROOT 在模块加载时求值，
// 必须在任何业务模块 import 之前设好，否则测试会写进仓库 ./data/。
process.env.AGENT_MEMORY_PATH = path.join(os.tmpdir(), `clickin-test-memory-${process.pid}`);

// Seed faker with the run-level seed set by global-setup.ts.
// Falls back to a random value if running outside the normal test runner.
const seed = process.env.TEST_SEED
  ? parseInt(process.env.TEST_SEED, 10)
  : Math.floor(Math.random() * 0xffff_ffff);

faker.seed(seed);
