/**
 * faker 逐文件播种的回归守护（#422）。
 *
 * 背景：tests/setup.ts 曾对每个测试文件用同一个 run 级 TEST_SEED 播种，所有文件
 * 抽出完全相同的 id 序列——insert 型工厂跨文件撞 id 报 duplicate key（显性），
 * upsert 型工厂（upsertFeishuUser）撞 open_id 则静默合并身份，别的文件的数据
 * 泄进本文件的聚合断言（ai-quota 5048≠5000 事故）。修复依赖两个前提，各守一条：
 *   1. setupFiles 加载时 expect.getState().testPath 已就位（vitest 语义，升级可能漂移）
 *   2. perFileSeed 对同路径确定、对异路径相异
 * 任一断言变红 = 修复静默失效，全套件退回同序列状态——先修这里再看别的红。
 */
import { describe, it, expect } from "vitest";
import { perFileSeed, fakerSeededPerFile } from "./setup";

describe("faker 逐文件播种守护", () => {
  it("setup 加载时 testPath 可用，本文件确实按文件路径播了种", () => {
    expect(expect.getState().testPath).toBeTruthy();
    expect(fakerSeededPerFile).toBe(true);
  });

  it("perFileSeed：同路径确定、异路径相异、值域为 uint32", () => {
    expect(perFileSeed("tests/a.test.ts")).toBe(perFileSeed("tests/a.test.ts"));
    expect(perFileSeed("tests/a.test.ts")).not.toBe(perFileSeed("tests/b.test.ts"));
    const s = perFileSeed(expect.getState().testPath!);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffff_ffff);
  });
});
