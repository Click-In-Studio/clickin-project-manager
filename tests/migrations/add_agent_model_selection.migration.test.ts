import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH,
  type Snapshot,
} from "./add_agent_model_selection.snapshot";
const snapshot: Snapshot | null = existsSync(SNAPSHOT_PATH)
  ? JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"))
  : null;
describe("模型选择迁移", () => {
  it("schema：会话与运行快照、子任务原件目录都有非空默认值", async () => {
    const rows = (
      await getPool().query(
        "SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns WHERE table_name IN ('agent_session','agent_run') AND column_name IN ('model_selection','attachment_ids')",
      )
    ).rows;
    expect(rows).toHaveLength(3);
    expect(
      rows.every((row) => row.is_nullable === "NO" && row.column_default),
    ).toBe(true);
  });
  it.skipIf(!snapshot)(
    "integrity/invariance：保持模型、账单和原始输入，仅增加对应配置",
    async () => {
      for (const before of snapshot!.rows) {
        const after = (
          await getPool().query(
            "SELECT to_jsonb(r) AS row FROM agent_run r WHERE id=$1",
            [before.id],
          )
        ).rows[0].row;
        expect(after.model_selection.modelKey).toBe(
          before.model === "deepseek-v4-pro"
            ? "deepseek-pro"
            : "deepseek-flash",
        );
        expect(after.attachment_ids).toEqual([]);
        delete after.model_selection;
        delete after.attachment_ids;
        expect(after).toEqual(before);
      }
    },
  );
});
