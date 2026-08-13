import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PERMISSION_MIGRATION_LEDGER,
  RETIRED_PERMISSION_KEYS,
  RESOURCE_LEVEL_MIGRATION_LEDGER,
} from "@/lib/permission-migration-ledger";

// 权限REST化棘轮：迁移遗漏必须变成测试红，而不是留在人的记忆里。
// 权威映射表在 MindWeave《权限REST化-Migration总表》，本测试强制其 CI 形态的不变量。

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "lib", "components"];
const SELF = path.join("lib", "permission-migration-ledger.ts");

function* walkSources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walkSources(p);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield p;
    }
  }
}

describe("棘轮不变量", () => {
  it("账本键集合 === ([] as readonly string[]) /* 终局：原子键全集为空 */ 集合（漏记或忘删都算红）", () => {
    const ledger = new Set(Object.keys(PERMISSION_MIGRATION_LEDGER));
    const all = new Set<string>(([] as readonly string[]) /* 终局：原子键全集为空 */);
    const missingFromLedger = [...all].filter((k) => !ledger.has(k));
    const staleInLedger = [...ledger].filter((k) => !all.has(k));
    expect(missingFromLedger, "存在未入账的原子键（新增键必须记入账本或不引入）").toEqual([]);
    expect(staleInLedger, "账本中存在已从 Permission type 删除的键（完成批次时须同步删行）").toEqual([]);
  });

  it("已退役键在源码中无任何消费点", () => {
    const offenders: string[] = [];
    if (RETIRED_PERMISSION_KEYS.length > 0) {
      for (const dir of SCAN_DIRS) {
        for (const file of walkSources(path.join(ROOT, dir))) {
          if (file.endsWith(SELF)) continue;
          const src = fs.readFileSync(file, "utf8");
          for (const key of RETIRED_PERMISSION_KEYS) {
            if (src.includes(`"${key}"`) || src.includes(`'${key}'`)) {
              offenders.push(`${path.relative(ROOT, file)} → ${key}`);
            }
          }
        }
      }
    }
    expect(offenders, "退役键仍被源码引用").toEqual([]);
  });

  it("退役键与待迁账本无交集", () => {
    const ledger = new Set(Object.keys(PERMISSION_MIGRATION_LEDGER));
    expect(RETIRED_PERMISSION_KEYS.filter((k) => ledger.has(k))).toEqual([]);
  });

  it("级别账本键格式合法（type:level）且不含动词字符串", () => {
    for (const key of Object.keys(RESOURCE_LEVEL_MIGRATION_LEDGER)) {
      expect(key).toMatch(/^[a-z_]+:[a-z_]+$/);
      const level = key.split(":")[1];
      // view/edit 沿用为动词不退役；create/delete 是新动词不应出现在退役账本
      expect(["view", "edit", "create", "delete"]).not.toContain(level);
    }
  });
});
