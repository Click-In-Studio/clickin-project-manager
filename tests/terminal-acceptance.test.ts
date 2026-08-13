import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";

// ─── 权限REST化 §0.5 终局判据（机器可判，非人的记忆）────────────────────────────
// 2026-08-11 开工 → 批0/A/B/C/D/E/F/G 八批完毕。本文件是工程的最终验收：
// 任何一条红 = 终局态被破坏。

describe("§0.5 终局判据", () => {
  it("① atomic_permission_grant 表不存在（168 原子键六批退役完毕）", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'atomic_permission_grant'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("② 行表终局命名 production_member_grant（resource_grant 已更名）", async () => {
    const [neu, alt] = await Promise.all([
      getPool().query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'production_member_grant'`),
      getPool().query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'resource_grant'`),
    ]);
    expect(neu.rows).toHaveLength(1);
    expect(alt.rows).toHaveLength(0);
  });

  it("③ 词汇表 = 四动词闭集（view/create/edit/delete，无线性级别残留）", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(
      `SELECT DISTINCT permission_level FROM resource_permission_level ORDER BY 1`,
    );
    expect(rows.map(r => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });

  it("④ 区间三表键全 node: 节点串形态（零原子键）", async () => {
    const [role, member, dept] = await Promise.all([
      getPool().query(`SELECT permission_key FROM production_role_permission WHERE permission_key NOT LIKE 'node:%' LIMIT 5`),
      getPool().query(`SELECT permission FROM production_member_permission WHERE permission NOT LIKE 'node:%' LIMIT 5`),
      getPool().query(`SELECT permission_key FROM production_dept_permission WHERE permission_key NOT LIKE 'node:%' LIMIT 5`),
    ]);
    expect(role.rows, "role 区间残留非节点键").toHaveLength(0);
    expect(member.rows, "member 区间残留非节点键").toHaveLength(0);
    expect(dept.rows, "dept 区间残留非节点键").toHaveLength(0);
  });

  it("⑤ 行表 permission_level 全动词（行体系与词汇闭集一致）", async () => {
    const { rows } = await getPool().query(
      `SELECT DISTINCT permission_level FROM production_member_grant
       WHERE permission_level NOT IN ('view', 'create', 'edit', 'delete') LIMIT 5`,
    );
    expect(rows).toHaveLength(0);
  });

  it("⑥ 制作人模板 = 通配区间（枚举时代终结）", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM grant_template WHERE role_name = '制作人' AND permission_key = 'node:*/*@*'`,
    );
    expect(rows).toHaveLength(1);
  });
});
