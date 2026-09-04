import { faker } from "@faker-js/faker";
import { beforeAll, expect } from "vitest";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

// Agent 记忆存储根指向进程专属临时目录：MEMORY_ROOT 在模块加载时求值，
// 必须在任何业务模块 import 之前设好，否则测试会写进仓库 ./data/。
process.env.AGENT_MEMORY_PATH = path.join(os.tmpdir(), `clickin-test-memory-${process.pid}`);

// 测试绝不调真 embedding 供应商：global-setup 会 load .env.local，本机一旦配了
// EMBEDDING_API_KEY，embeddingMode() 就自动进 dashscope——每个 run 都先去网络嵌一次
// 查询（几百 ms），靠 100ms 定时的测试（abort/steer）会错位。要向量车道的测试自己
// 显式设 EMBEDDING_PROVIDER=fake。
process.env.EMBEDDING_PROVIDER ??= "none";

// Seed faker with the run-level seed set by global-setup.ts.
// Falls back to a random value if running outside the normal test runner.
const seed = process.env.TEST_SEED
  ? parseInt(process.env.TEST_SEED, 10)
  : Math.floor(Math.random() * 0xffff_ffff);

// 逐文件错开 faker 序列：本 setup 每个测试文件都会重新执行，若所有文件都用同一个
// run 种子，每个文件抽出的 id 序列**完全相同**——insert 型工厂（makeProduction）
// 跨文件撞 id 时报 duplicate key，而 upsert 型工厂（upsertFeishuUser）会静默合并
// 身份，让另一个文件的数据泄进本文件的聚合断言（ai-quota 5048≠5000 事故）。
// 种子混入测试文件路径后：同一 TEST_SEED 下单文件序列照旧可复现
// （TEST_SEED=xxx npm test 不受影响），但任意两个文件的序列不再重叠。
function perFileSeed(testPath: string): number {
  return createHash("md5").update(`${seed}:${testPath}`).digest().readUInt32BE(0);
}

let seededForFile = false;
const testPathAtLoad = expect.getState().testPath;
if (testPathAtLoad) {
  faker.seed(perFileSeed(testPathAtLoad));
  seededForFile = true;
} else {
  faker.seed(seed);
}
// 兜底：个别 vitest 版本在 setupFiles 加载时还没挂 testPath，等 beforeAll 再定。
// 只在加载时没定成的情况下补播，避免同文件内重播造成序列自重叠。
beforeAll(() => {
  if (seededForFile) return;
  const tp = expect.getState().testPath;
  if (tp) {
    faker.seed(perFileSeed(tp));
    seededForFile = true;
  }
});
