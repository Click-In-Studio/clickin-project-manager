/**
 * 一次性回填：给所有存量演出物化 production_policy 全量键（#236）。
 *
 * 跑法：npx tsx scripts/backfill-production-policies.ts
 *      npx tsx scripts/backfill-production-policies.ts --dry-run   （只报告，不写）
 *
 * 为什么需要它：`ensureProductionPolicies` 只在**建演出时**与**策略中心读接口进入时**
 * 被调用，故 add-production-policy.sql 建表之后，存量演出的 production_policy 是空的。
 * 空着不会出错——读路径对缺行有防御性回落（用代码默认），行为与今天一致——但那正是
 * 「稀疏存储」的形态，也就意味着**此后改一次代码默认值，会静默改变所有还没被物化过的
 * 演出的行为，且不留痕迹**。本脚本把这批演出一次性冻结在当前默认值上。
 *
 * 幂等：ensureProductionPolicies 只补缺行、**永不覆盖已改过的值**，可重复执行。
 * 归档演出照样回填——回填不是修改配置，只是把默认值落到行上。
 */

import { getPool } from "../lib/pg";
import { ensureProductionPolicies } from "../lib/policy-db";
import { POLICY_KEYS } from "../lib/policy-keys";

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const pool = getPool();
  const { rows: prods } = await pool.query<{ id: string; name: string; n: string }>(
    `SELECT p.id, p.name, COUNT(pp.policy_key)::text AS n
     FROM production p
     LEFT JOIN production_policy pp ON pp.production_id = p.id
     GROUP BY p.id, p.name, p.created_at
     ORDER BY p.created_at`,
  );

  const total = POLICY_KEYS.length;
  console.log(`词汇表共 ${total} 个键；演出 ${prods.length} 个。\n`);

  let touched = 0;
  for (const p of prods) {
    const have = Number(p.n);
    const missing = total - have;
    if (missing <= 0) {
      console.log(`  ✓ ${p.name} (${p.id}) — 已物化 ${have}/${total}，跳过`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  · ${p.name} (${p.id}) — 缺 ${missing} 个键（dry-run，未写）`);
      touched++;
      continue;
    }
    await ensureProductionPolicies(p.id);
    const { rows: [after] } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM production_policy WHERE production_id = $1`, [p.id],
    );
    console.log(`  + ${p.name} (${p.id}) — 补 ${missing} 个键，现 ${after.n}/${total}`);
    touched++;
  }

  // 核对：全库不得出现词汇表以外的键（同 tests/production-policy.test.ts 的幽灵键棘轮）
  const { rows: ghosts } = await pool.query<{ policy_key: string }>(
    `SELECT DISTINCT policy_key FROM production_policy`,
  );
  const known = new Set(POLICY_KEYS.map((d) => d.key));
  const unknown = ghosts.map((g) => g.policy_key).filter((k) => !known.has(k));

  console.log(`\n${DRY_RUN ? "[dry-run] 需回填" : "已回填"} ${touched} 个演出。`);
  if (unknown.length > 0) {
    console.error(`⚠ 发现词汇表以外的幽灵键 ${unknown.length} 个：${unknown.join(", ")}`);
    console.error("  （词汇表改名/删键后没清理存量行——查 lib/policy-keys.ts）");
    process.exitCode = 1;
  } else {
    console.log("幽灵键检查：通过。");
  }

  // 偏离默认的键：回填不该产生任何偏离，若有说明是人改过的，列出来给人看一眼
  const { rows: drift } = await pool.query<{ production_id: string; policy_key: string; value: string }>(
    `SELECT production_id, policy_key, value FROM production_policy ORDER BY production_id, policy_key`,
  );
  const defaults = new Map(POLICY_KEYS.map((d) => [d.key, d.defaultValue]));
  const changed = drift.filter((r) => defaults.get(r.policy_key) !== r.value);
  if (changed.length > 0) {
    console.log(`\n已偏离默认的配置 ${changed.length} 条（人为改动，回填不会覆盖）：`);
    for (const c of changed) console.log(`  ${c.production_id}  ${c.policy_key} = ${c.value}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
