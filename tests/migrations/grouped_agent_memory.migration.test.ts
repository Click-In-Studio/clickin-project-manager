import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH,
  type GroupedSnapshot,
} from "./grouped_agent_memory.snapshot";
let snapshot: GroupedSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  snapshot = null;
}
describe("grouped_agent_memory schema", () => {
  it("两张关系/组表与缓存索引落地，旧dream游标退出", async () => {
    const result = await getPool().query(
      "SELECT table_name FROM information_schema.tables WHERE table_name=ANY($1::text[])",
      [["agent_memory_group", "agent_memory_relation"]],
    );
    expect(result.rows.map((r) => r.table_name).sort()).toEqual([
      "agent_memory_group",
      "agent_memory_relation",
    ]);
    expect(
      (
        await getPool().query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='agent_memory_scope' AND column_name IN ('consumed_seq','dream_project_ids')",
        )
      ).rows,
    ).toEqual([]);
  });
});
describe("grouped_agent_memory integrity", () => {
  it("无真实作用域不能创建组", async () => {
    await expect(
      getPool().query(
        "INSERT INTO agent_memory_group(id,scope_id) VALUES('bad-group-1034','missing-scope-1034')",
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
describe("grouped_agent_memory invariance", () => {
  it.skipIf(!snapshot)(
    "无条件工厂旧条目正文、修订、用户标记与时间保留，转为单成员组",
    async () => {
      const rows = (
        await getPool().query(
          "SELECT e.*,g.member_count,g.in_cache FROM agent_memory_entry e JOIN agent_memory_group g ON g.id=e.group_id WHERE e.id=ANY($1::text[]) ORDER BY e.body",
          [snapshot!.entryIds],
        )
      ).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(snapshot!.bodies).toContain(row.body);
        expect(row.brief).toBe(row.body);
        expect(row.source).toBe("active");
        expect(Number(row.revision)).toBe(2);
        expect(row.created_at).toEqual(row.updated_at);
        expect(row.member_count).toBe(1);
        expect(row.in_cache).toBe(true);
      }
      expect(
        rows.find((r) => r.body === "用户修改的长期要求")?.user_edited,
      ).toBe(true);
    },
  );
});
