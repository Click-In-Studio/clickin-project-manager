// 一次性导入旧服务端对话归档；不导入混合 MEMORY.md，不重置删除边界。
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import fs from "node:fs";
import path from "node:path";
import { parseSessionIdentity } from "../lib/agent/tools/session-identity-parse";
import { getPool } from "../lib/pg";
import type { RunRecord } from "../lib/agent/memory/store";
import { embedMissing, ensureIndexIdentity, indexEpisodicRun } from "../lib/agent/memory/index-db";

async function main() {
  const pool = getPool();
  if (process.argv.includes("--rebuild")) {
    await pool.query("UPDATE agent_memory_chunk SET embedding=NULL,model=NULL");
    await pool.query("DELETE FROM agent_memory_index_meta");
  }
  if (!(await ensureIndexIdentity())) throw new Error("索引身份与配置不符，换模型后使用 --rebuild");
  const root = process.env.AGENT_MEMORY_PATH;
  if (root && fs.existsSync(root)) {
    const users = (await pool.query<{ id: string }>("SELECT id FROM app_user")).rows;
    for (const { id } of users) {
      const file = path.join(root, id, "runs.jsonl");
      if (!fs.existsSync(file)) continue;
      let imported = 0;
      let skipped = 0;
      for (const line of fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim())) {
        try {
          const record = JSON.parse(line) as RunRecord;
          // 老格式项目归属只从服务端归档中的会话键解析，未知归属不能误当通用材料。
          if (!record.runId) {
            const identity = parseSessionIdentity(record.sessionKey);
            if (!identity || identity.userId !== id) { skipped++; continue; }
            record.productionId = identity.productionId ?? null;
          }
          await indexEpisodicRun(id, record, { deferEmbedding: true });
          imported++;
        } catch { skipped++; }
      }
      console.log(`[backfill] ${id}：已处理 ${imported}，无法验证 ${skipped}`);
    }
  }
  let total = 0;
  for (;;) {
    const count = await embedMissing(200);
    total += count;
    if (!count) break;
  }
  console.log(`[backfill] 补齐 ${total} 个向量；条目、消费游标和删除边界保留`);
  await pool.end();
}
main().catch(err => { console.error("[backfill] 失败", err); process.exit(1); });
