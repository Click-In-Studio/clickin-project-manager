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
import { TEST_USER } from "./helpers";
import { shortId } from "./factories";

const TEST_PROD_ID = `test-prod-${shortId()}`;

afterAll(() => deleteProduction(TEST_PROD_ID).catch(() => {}));

describe("listProductions", () => {
  it("admin sees productions (no filter by membership)", async () => {
    await createProduction(TEST_PROD_ID, "单元测试演出");
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
