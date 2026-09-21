/**
 * retire_agent_user_role（#603）验证。
 *
 * agent_user 是 OpenClaw 时代 click_in_agent 库的应用用户，OpenClaw 退役（#367）后
 * 它在主库 26 张表上的 DML 授权与 click_in_agent 的库级授权一直挂着。
 *
 * 层 1 schema：主库里没有任何对象权限再授给 agent_user（表 / 序列 / 库级 ACL）。
 *   角色本身可能还在——migration 跑在 script_editor 里够不着 click_in_agent 内的
 *   表级 ACL，那一步由人在服务器上收尾（docs/DEPLOY.md）——所以这里盯的是授权
 *   而不是 pg_roles。CI 空库从没建过该角色，三条查询天然为空；本机 / 线上若
 *   migration 没跑或没生效，第一条就红。
 * 层 2 integrity：应用用户 script_editor 的授权没被 DROP OWNED 误伤。
 * 层 3 invariance：不适用——纯回收权限、无数据转换、无 hook。
 */
import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";

// ── 层 1：schema 验证 ─────────────────────────────────────────────────────────
describe("schema verification", () => {
  it("主库没有表 / 序列权限再授给 agent_user", async () => {
    const { rows } = await getPool().query<{ kind: string; name: string }>(
      `SELECT 'table' AS kind, table_name AS name FROM information_schema.role_table_grants
         WHERE grantee = 'agent_user'
       UNION ALL
       SELECT 'sequence', object_name FROM information_schema.role_usage_grants
         WHERE grantee = 'agent_user' AND object_type = 'SEQUENCE'
       ORDER BY 1, 2`,
    );
    expect(rows).toEqual([]);
  });

  it("库级 ACL 里没有 agent_user（含 click_in_agent 的 GRANT ALL ON DATABASE）", async () => {
    const { rows } = await getPool().query<{ datname: string }>(
      `SELECT datname FROM pg_database
       WHERE datacl IS NOT NULL AND array_to_string(datacl, ',') LIKE '%agent_user=%'`,
    );
    expect(rows).toEqual([]);
  });
});

// ── 层 2：完整性验证 ──────────────────────────────────────────────────────────
describe("integrity verification", () => {
  it("应用用户 script_editor 的表授权没被误伤（DROP OWNED 只认 agent_user）", async () => {
    // 本机可能不用 script_editor 角色（peer auth 直接用 OS 用户），角色不在就跳过判定。
    const { rows: roles } = await getPool().query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'script_editor'`,
    );
    if (roles.length === 0) return;
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND NOT has_table_privilege('script_editor', quote_ident(t.table_name), 'SELECT')`,
    );
    expect(rows[0].n).toBe("0");
  });
});
