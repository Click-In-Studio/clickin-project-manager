import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";
export const SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "grouped-agent-memory-snapshot.json",
);
export type GroupedSnapshot = {
  scopeId: string;
  entryIds: string[];
  bodies: string[];
};
export const createPreMigrationData: MigrationHook<GroupedSnapshot>["createPreMigrationData"] =
  async ({ pool, testOwner, faker }) => {
    const scopeId = `ms_${faker.string.alphanumeric(12)}`;
    await pool.query(
      "INSERT INTO agent_memory_scope(id,user_id,scope_key) VALUES($1,$2,'') ON CONFLICT(user_id,scope_key) DO UPDATE SET dream_project_ids='{}' RETURNING id",
      [scopeId, testOwner],
    );
    const actual = (
      await pool.query<{ id: string }>(
        "SELECT id FROM agent_memory_scope WHERE user_id=$1 AND scope_key=''",
        [testOwner],
      )
    ).rows[0].id;
    const ids = [
      `me_${faker.string.alphanumeric(12)}`,
      `me_${faker.string.alphanumeric(12)}`,
    ];
    const bodies = ["迁移前的项目采用约定", "用户修改的长期要求"];
    for (let i = 0; i < ids.length; i++)
      await pool.query(
        "INSERT INTO agent_memory_entry(id,scope_id,source,body,user_edited,revision) VALUES($1,$2,$3,$4,$5,2)",
        [ids[i], actual, i ? "active" : "dream", bodies[i], !!i],
      );
    return { scopeId: actual, entryIds: ids, bodies };
  };
export const cleanup: MigrationHook<GroupedSnapshot>["cleanup"] = async (
  pool,
  snapshot,
) => {
  await pool.query("DELETE FROM agent_memory_scope WHERE id=$1", [
    snapshot.scopeId,
  ]);
};
