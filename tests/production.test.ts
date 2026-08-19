import { describe, it, expect, afterAll } from "vitest";
import {
  listProductions,
  listMyProductionsWithRoles,
  createProduction,
  getProductionName,
  updateProductionName,
  archiveProduction,
  isProductionArchived,
  unarchiveProduction,
  deleteProduction,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { readFileSync } from "fs";
import path from "path";
import { TEST_USER, TEST_OWNER } from "./helpers";
import { shortId } from "./factories";

const TEST_PROD_ID = `test-prod-${shortId()}`;

afterAll(() => deleteProduction(TEST_PROD_ID).catch(() => {}));

describe("listProductions", () => {
  it("admin sees productions (no filter by membership)", async () => {
    await createProduction(TEST_PROD_ID, "单元测试演出", TEST_OWNER);
    const list = await listProductions({ userId: TEST_USER, isAdmin: true });
    expect(list.some((p) => p.id === TEST_PROD_ID)).toBe(true);
  });

  it("non-member sees no productions when not admin", async () => {
    const list = await listProductions({ userId: TEST_USER, isAdmin: false });
    expect(list.every((p) => p.id !== TEST_PROD_ID)).toBe(true);
  });
});

describe("production CRUD", () => {
  it("createProduction creates a new production", async () => {
    expect(await getProductionName(TEST_PROD_ID)).toBe("单元测试演出");
  });

  it("updateProductionName renames it", async () => {
    await updateProductionName(TEST_PROD_ID, "单元测试演出（改名）");
    expect(await getProductionName(TEST_PROD_ID)).toBe("单元测试演出（改名）");
  });

  it("archiveProduction marks it archived", async () => {
    await archiveProduction(TEST_PROD_ID);
    expect(await isProductionArchived(TEST_PROD_ID)).toBe(true);
  });

  it("unarchiveProduction restores it", async () => {
    await unarchiveProduction(TEST_PROD_ID);
    expect(await isProductionArchived(TEST_PROD_ID)).toBe(false);
  });

  it("deleteProduction removes it", async () => {
    await deleteProduction(TEST_PROD_ID);
    expect(await getProductionName(TEST_PROD_ID)).toBeNull();
  });
});

// ── owner 的可见性 ─────────────────────────────────────────────────────────────
//
// 回归 #281 后遗症：建项目的人建完就从自己的项目列表里消失。createProduction 只写
// production.owner_id，两条列表查询却只认 production_member 行——以前建项目的人恒是
// admin（走全量分支）挡住了这个洞，创建放开后立刻暴露。
//
// 两层：① owner 建完就有成员行；② 就算没有成员行（历史项目、owner 被移出成员），
// owner 仍看得见——owner 不必是成员，这是 getProductionPermissionContext 的既有语义。

describe("owner 可见性", () => {
  const OWNER_PROD = `test-owner-vis-${shortId()}`;

  afterAll(() => deleteProduction(OWNER_PROD).catch(() => {}));

  it("createProduction 给 owner 落一行 production_member", async () => {
    await createProduction(OWNER_PROD, "owner 可见性测试", TEST_OWNER);
    const { rows } = await getPool().query(
      "SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2",
      [OWNER_PROD, TEST_OWNER],
    );
    expect(rows).toHaveLength(1);
  });

  it("owner（非 admin）在 listProductions 里看得见自己建的项目", async () => {
    const list = await listProductions({ userId: TEST_OWNER, isAdmin: false });
    expect(list.some((p) => p.id === OWNER_PROD)).toBe(true);
  });

  it("owner（非 admin）在 listMyProductionsWithRoles 里看得见，且 isOwner", async () => {
    const list = await listMyProductionsWithRoles(TEST_OWNER, false, []);
    expect(list.find((p) => p.id === OWNER_PROD)?.isOwner).toBe(true);
  });

  // 缺行分支专测：成员行被删掉后两条列表都不能把项目藏掉。删了这个分支（把查询改回
  // 内连接 production_member / 去掉 OR owner_id）这两条会红——上面三条不会，因为
  // createProduction 补的成员行会盖住它。
  it("owner 没有成员行时，两条列表仍看得见", async () => {
    await getPool().query(
      "DELETE FROM production_member WHERE production_id = $1 AND user_id = $2",
      [OWNER_PROD, TEST_OWNER],
    );
    const { rows } = await getPool().query(
      "SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2",
      [OWNER_PROD, TEST_OWNER],
    );
    expect(rows).toHaveLength(0);  // 前提坐实：这条测的确实是"没有成员行"

    const plain = await listProductions({ userId: TEST_OWNER, isAdmin: false });
    expect(plain.some((p) => p.id === OWNER_PROD)).toBe(true);

    const withRoles = await listMyProductionsWithRoles(TEST_OWNER, false, []);
    expect(withRoles.find((p) => p.id === OWNER_PROD)?.isOwner).toBe(true);
  });
});

// ── 存量回填 SQL ───────────────────────────────────────────────────────────────
//
// db/add-owner-member-backfill.sql 给线上已存在的项目补 owner 的成员行。在事务里跑完
// 回滚——共享测试库不该被回填结果污染（别的文件有「非成员看不到项目」这类断言）。

describe("add-owner-member-backfill.sql", () => {
  it("补上缺失的 owner 成员行，且重复执行幂等", async () => {
    const sql = readFileSync(
      path.join(process.cwd(), "db", "add-owner-member-backfill.sql"), "utf8",
    );
    const prodId = `test-backfill-${shortId()}`;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)",
        [prodId, "回填测试演出", TEST_OWNER],
      );
      // 前提坐实：这一行是 createProduction 之外手工建的，没有成员行
      await client.query(
        "DELETE FROM production_member WHERE production_id = $1", [prodId],
      );

      await client.query(sql);
      const after = await client.query(
        "SELECT roles FROM production_member WHERE production_id = $1 AND user_id = $2",
        [prodId, TEST_OWNER],
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].roles).toEqual([]);  // 只表示在项目里，不授权

      // 幂等：再跑一次不炸、不重复插
      await client.query(sql);
      const again = await client.query(
        "SELECT count(*) AS n FROM production_member WHERE production_id = $1 AND user_id = $2",
        [prodId, TEST_OWNER],
      );
      expect(Number(again.rows[0].n)).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
