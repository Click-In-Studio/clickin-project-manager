import { describe, it, expect, afterAll } from "vitest";
import {
  listProductions,
  createProduction,
  getProductionName,
  updateProductionName,
  archiveProduction,
  isProductionArchived,
  unarchiveProduction,
  deleteProduction,
} from "@/lib/db";
import { TEST_USER, PROD_HOSHINO, PROD_SUPPLY } from "./helpers";

const TEST_PROD_ID = "test-prod-unit";

afterAll(() => deleteProduction(TEST_PROD_ID).catch(() => {}));

describe("listProductions", () => {
  it("admin sees all seeded productions", async () => {
    const list = await listProductions({ openId: TEST_USER, isAdmin: true });
    const ids = list.map((p) => p.id);
    expect(ids).toContain(PROD_HOSHINO);
    expect(ids).toContain(PROD_SUPPLY);
  });

  it("non-member sees no productions when not admin", async () => {
    const list = await listProductions({ openId: TEST_USER, isAdmin: false });
    expect(list.length).toBe(0);
  });
});

describe("production CRUD", () => {
  it("createProduction creates a new production", async () => {
    await createProduction(TEST_PROD_ID, "单元测试演出");
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
