/**
 * 记忆索引回填/重建脚本（M1 上线后手动跑一次；embedding 配置变更后 --rebuild）。
 *
 * 用法（服务器在 current/ 目录，读 .env.local 的 PG* 与 EMBEDDING_* 配置）：
 *   npx tsx scripts/memory-index-backfill.ts            # 增量：索引存量文件 + 补齐 NULL embedding
 *   npx tsx scripts/memory-index-backfill.ts --rebuild  # 重建：清空 chunk 表与索引身份后全量重跑
 *                                                        # （换 embedding 模型/维度后必须走这条）
 *
 * 幂等：内容 hash 冲突 DO NOTHING / curated 差量替换；重复跑只补缺不重复计费
 * （embedding 缓存按 (model, hash) 查重）。
 */
import fs from "node:fs";
import path from "node:path";
import { getPool } from "../lib/pg";
import { listUserIds, memoryRoot, type RunRecord } from "../lib/agent-memory/store";
import { embedMissing, ensureIndexIdentity, indexCurated, indexEpisodicRun } from "../lib/agent-memory/index-db";

async function main() {
  const rebuild = process.argv.includes("--rebuild");
  const pool = getPool();

  if (rebuild) {
    console.log("[backfill] --rebuild：清空 agent_memory_chunk 与索引身份（embedding 缓存保留，同模型重建零 API 调用）");
    await pool.query("TRUNCATE agent_memory_chunk CASCADE");
    await pool.query("DELETE FROM agent_memory_index_meta");
  }
  if (!(await ensureIndexIdentity())) {
    console.error("[backfill] 索引身份与当前 EMBEDDING_* 配置不符——换过模型/维度必须 --rebuild");
    process.exit(1);
  }

  const users = listUserIds();
  console.log(`[backfill] ${users.length} 个用户目录（root=${memoryRoot()}）`);

  for (const userId of users) {
    // curated：MEMORY.md 全文（不走注入面的 4000 字符截断——索引要完整语料）
    const memFile = path.join(memoryRoot(), userId, "MEMORY.md");
    if (fs.existsSync(memFile)) {
      const md = fs.readFileSync(memFile, "utf-8").trim();
      if (md) {
        await indexCurated("user", userId, md);
        console.log(`[backfill] ${userId} curated 完成`);
      }
    }

    // episodic：runs.jsonl 全量逐条（store 的读取器都是尾部窗口/偏移增量，
    // 回填要全文件，这里直接读）
    const runsFile = path.join(memoryRoot(), userId, "runs.jsonl");
    if (fs.existsSync(runsFile)) {
      const lines = fs.readFileSync(runsFile, "utf-8").split("\n").filter((l) => l.trim());
      let ok = 0;
      for (const line of lines) {
        let rec: RunRecord;
        try {
          rec = JSON.parse(line) as RunRecord;
        } catch {
          continue;
        }
        await indexEpisodicRun(userId, rec);
        ok++;
      }
      console.log(`[backfill] ${userId} episodic ${ok}/${lines.length} 条`);
    }
  }

  // 供应商中断期间落的 NULL embedding 补齐
  let total = 0;
  for (;;) {
    const n = await embedMissing(200);
    total += n;
    if (n === 0) break;
  }
  if (total > 0) console.log(`[backfill] 补齐 ${total} 个缺失 embedding`);

  const { rows } = await pool.query(
    "SELECT source, count(*)::int AS n, count(embedding)::int AS embedded FROM agent_memory_chunk GROUP BY source",
  );
  console.log("[backfill] 完成：", rows);
  await pool.end();
}

main().catch((err) => {
  console.error("[backfill] 失败:", err);
  process.exit(1);
});
