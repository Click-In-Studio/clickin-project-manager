/**
 * createProduction 的原子性（#282 review 后补）。
 *
 * 建项目原先是三段各自提交：裸 pool.query 插 production 行、createInitialVersion 自己
 * 一个事务、applyProductionTemplate 自己一个事务。中途任一步抛错，前面提交过的行都留
 * 在库里——路由 catch 后回「创建失败」500，用户以为没建成，库里却躺着一个没有 version、
 * 没有模版的半成品项目。以前这种残骸只有 admin 的全量列表看得见，创建放开（#281）+
 * owner 可见（#282）之后它会直接出现在建项目的人自己的列表里。
 *
 * 现在全程一个事务。这里让最后一步（模版灌入）抛错，断言前面三步一起回滚。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPool } from "@/lib/pg";
import { TEST_OWNER } from "./helpers";
import { shortId } from "./factories";

const templateFails = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/production-template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/production-template")>();
  return {
    ...actual,
    applyProductionTemplate: async (...args: Parameters<typeof actual.applyProductionTemplate>) => {
      if (templateFails.value) throw new Error("模版灌入炸了（测试注入）");
      return actual.applyProductionTemplate(...args);
    },
  };
});

const { createProduction } = await import("@/lib/db");

beforeEach(() => { templateFails.value = false; });

describe("createProduction 原子性", () => {
  it("模版灌入抛错 → production / production_member / version 一行都不留", async () => {
    templateFails.value = true;
    const id = `test-atomic-${shortId()}`;

    await expect(createProduction(id, "半成品不该留下", TEST_OWNER)).rejects.toThrow();

    const pool = getPool();
    const prod = await pool.query("SELECT 1 FROM production WHERE id = $1", [id]);
    expect(prod.rows).toHaveLength(0);
    const member = await pool.query(
      "SELECT 1 FROM production_member WHERE production_id = $1", [id],
    );
    expect(member.rows).toHaveLength(0);
    const version = await pool.query(
      "SELECT 1 FROM version WHERE production_id = $1", [id],
    );
    expect(version.rows).toHaveLength(0);
  });

  it("不注入错误时照常建成（确认上面测的是回滚，不是根本没建）", async () => {
    const id = `test-atomic-ok-${shortId()}`;
    try {
      await createProduction(id, "正常建成", TEST_OWNER);
      const pool = getPool();
      const prod = await pool.query("SELECT active_version_id FROM production WHERE id = $1", [id]);
      expect(prod.rows).toHaveLength(1);
      expect(prod.rows[0].active_version_id).toBeTruthy();
      const member = await pool.query(
        "SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2",
        [id, TEST_OWNER],
      );
      expect(member.rows).toHaveLength(1);
      // 模版确实灌进去了（角色行是模版 seeder 建的）
      const roles = await pool.query("SELECT 1 FROM production_role WHERE production_id = $1", [id]);
      expect(roles.rows.length).toBeGreaterThan(0);
    } finally {
      await getPool().query("DELETE FROM production WHERE id = $1", [id]).catch(() => {});
    }
  });
});
