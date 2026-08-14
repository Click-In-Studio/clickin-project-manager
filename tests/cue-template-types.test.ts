import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  listCueTemplateTypes,
  createCueTemplateType,
  deleteCueTemplateType,
  upsertDeptCueTemplate,
  deleteDeptCueTemplate,
} from "@/lib/cue-template-db";
import { DEFAULT_CUE_TEMPLATE_TYPES } from "@/lib/cue-list-types";
import { createProductionDept } from "@/lib/dept-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// #227 Cue 模版类型注册表：新项目 seed 内置八类、自定义类型 CRUD、删除保护

let prodId: string;
let userId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  userId = u.rows[0].id;
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = $1", [userId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("seed", () => {
  it("createProduction 自动灌入内置八类型（含 abbr 提示）", async () => {
    const types = await listCueTemplateTypes(prodId);
    expect(types.map(t => t.key)).toEqual(DEFAULT_CUE_TEMPLATE_TYPES.map(t => t.key));
    expect(types.find(t => t.key === "灯光")?.abbrHint).toBe("LQ");
  });
});

describe("自定义类型 CRUD", () => {
  it("新增类型排在末位；同名冲突抛错", async () => {
    const t = await createCueTemplateType(prodId, "服装", "WQ");
    const types = await listCueTemplateTypes(prodId);
    expect(types[types.length - 1]?.key).toBe("服装");
    expect(t.abbrHint).toBe("WQ");
    await expect(createCueTemplateType(prodId, "服装", null)).rejects.toThrow();
    expect((await deleteCueTemplateType(prodId, t.id)).ok).toBe(true);
  });

  it("删除保护：有存量 cue 表 → in_use；有声明行 → has_declarations", async () => {
    const t1 = await createCueTemplateType(prodId, `占用${shortId()}`, null);
    await getPool().query(
      "INSERT INTO cue_list (id, production_id, name, template, created_by) VALUES ($1, $2, 'T', $3, $4)",
      [`cl${shortId()}`, prodId, t1.key, userId],
    );
    expect(await deleteCueTemplateType(prodId, t1.id)).toEqual({ ok: false, reason: "in_use" });

    const t2 = await createCueTemplateType(prodId, `声明${shortId()}`, null);
    const dept = await createProductionDept({ productionId: prodId, name: `部${shortId()}` });
    await upsertDeptCueTemplate(prodId, dept.id, t2.key, true, ["@view"]);
    expect(await deleteCueTemplateType(prodId, t2.id)).toEqual({ ok: false, reason: "has_declarations" });
    await deleteDeptCueTemplate(prodId, dept.id, t2.key);
    expect((await deleteCueTemplateType(prodId, t2.id)).ok).toBe(true);

    expect(await deleteCueTemplateType(prodId, "00000000-0000-0000-0000-000000000000")).toEqual({ ok: false, reason: "not_found" });
  });
});
