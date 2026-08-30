/**
 * 排版模版的落库（#338 T3）：模版预设 id 住在主本的 `script_view.template_overrides.templateId`，
 * 经 ScriptConfig.templateId 进出；config PUT 只认注册表里的预设；改模版 = 改全局页码，
 * page_map 要跟着重算。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { getEstimatedPageMap, getMasterScriptViewId, loadPageMap, loadProduction, saveScriptConfig } from "@/lib/db";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";
import { computePageMap } from "@/lib/script-page";
import { LEGACY_CENTER, LEGACY_COMPACT } from "@/lib/script-template/presets/legacy";
import { isKnownTemplateId, listTemplatePresets, resolveTemplate, TEMPLATE_PRESETS } from "@/lib/script-template";
import { PUT as configPUT } from "@/app/api/script/[id]/config/route";
import { addProductionMember } from "@/lib/db";
import { makeProduction, cleanupProduction, makeScene, makeBlocks } from "./factories";

let prodId: string;
let versionId: string;
let owner: string;

const ctx = () => ({ params: Promise.resolve({ id: prodId }) }) as never;
function putConfig(body: Record<string, unknown>, asUser: string = owner) {
  return configPUT(new NextRequest(`http://localhost/api/script/${prodId}/config`, {
    method: "PUT",
    headers: {
      cookie: `${SESSION_COOKIE}=${createSession({ userId: asUser, name: "测试", avatarUrl: null, isAdmin: false })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...DEFAULT_SCRIPT_CONFIG, ...body }),
  }), ctx());
}
async function grant(userId: string, type: string, id: string, sub: string, verb: string) {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'direct', $2)`,
    [prodId, userId, type, id, sub, verb],
  );
}
async function storedTemplateId(): Promise<string | null> {
  const masterId = await getMasterScriptViewId(prodId);
  const r = await getPool().query<{ t: string | null }>("SELECT template_overrides->>'templateId' AS t FROM script_view WHERE id = $1", [masterId]);
  return r.rows[0]?.t ?? null;
}

beforeAll(async () => {
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  owner = u.rows[0].id;
  ({ prodId, versionId } = await makeProduction(owner));
  await makeScene(prodId, versionId, { number: "1", name: "场" });
  await makeBlocks(prodId, versionId, 6);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("预设注册表", () => {
  it("预设 id 带版本；选择列表只列每个家族的最新版", () => {
    expect(LEGACY_CENTER.id).toBe("legacy-center@1");
    expect(LEGACY_COMPACT.id).toBe("legacy-compact@1");
    for (const id of Object.keys(TEMPLATE_PRESETS)) expect(id).toMatch(/^[a-z-]+@\d+$/);
    const listed = listTemplatePresets().map((t) => t.id.split("@")[0]);
    expect(new Set(listed).size).toBe(listed.length);
  });
  it("resolveTemplate：有 templateId 用它，否则按 textLayoutMode 回退", () => {
    expect(resolveTemplate({ templateId: null, textLayoutMode: "compact" }).id).toBe("legacy-compact@1");
    expect(resolveTemplate({ templateId: "legacy-center@1", textLayoutMode: "compact" }).id).toBe("legacy-center@1");
    expect(resolveTemplate({ templateId: "nope@9", textLayoutMode: "center" }).id).toBe("legacy-center@1");
    expect(isKnownTemplateId("legacy-center@1")).toBe(true);
    expect(isKnownTemplateId("legacy-center")).toBe(false);
    // 注册表是普通对象：原型上的键不是模版
    for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(isKnownTemplateId(bad), bad).toBe(false);
      expect(resolveTemplate({ templateId: bad, textLayoutMode: "center" }).id).toBe("legacy-center@1");
    }
  });
});

describe("落库与读出", () => {
  it("新建演出没有模版 id：config.templateId 为 null，主本 JSONB 里没有这个键", async () => {
    expect((await loadProduction(prodId, versionId))!.state.config.templateId).toBeNull();
    expect(await storedTemplateId()).toBeNull();
  });

  it("config PUT 写入主本的 template_overrides.templateId，loadProduction 读回", async () => {
    const res = await putConfig({ templateId: "legacy-compact@1" });
    expect(res.status).toBe(200);
    expect(await storedTemplateId()).toBe("legacy-compact@1");
    expect((await loadProduction(prodId, versionId))!.state.config.templateId).toBe("legacy-compact@1");
  });

  it("未知的模版 id 被 400 拒绝，库里不变（含原型键）", async () => {
    for (const bad of ["broadway-musical@99", "toString", "__proto__"]) {
      const res = await putConfig({ templateId: bad });
      expect(res.status, bad).toBe(400);
    }
    expect(await storedTemplateId()).toBe("legacy-compact@1");
  });

  // template_overrides 在 schema 里 NOT NULL DEFAULT '{}'（B2），写入 SQL 仍带 COALESCE 防御；
  // 不在测试里 DROP NOT NULL 去造 NULL 行——测试不做 DDL。
  it("改模版 = 改全局页码：page_map 按新模版重算；置 null 回退到 textLayoutMode 并删掉键", async () => {
    const { state } = (await loadProduction(prodId, versionId))!;
    const masterId = (await getMasterScriptViewId(prodId))!;
    // 当前是 legacy-compact@1（上面存的），页码应按它算
    expect(await getEstimatedPageMap(prodId, versionId)).toEqual(computePageMap(state.blocks, "a4", "center", false, "legacy-compact@1"));
    expect((await loadPageMap(prodId))?.[masterId]).toEqual(computePageMap(state.blocks, "a4", "center", false, "legacy-compact@1"));

    await saveScriptConfig(prodId, versionId, { ...DEFAULT_SCRIPT_CONFIG, templateId: null, textLayoutMode: "center" });
    expect(await storedTemplateId()).toBeNull();
    const r = await getPool().query<{ o: Record<string, unknown> }>("SELECT template_overrides AS o FROM script_view WHERE id = $1", [masterId]);
    expect("templateId" in r.rows[0].o).toBe(false);
    expect(await getEstimatedPageMap(prodId, versionId)).toEqual(computePageMap(state.blocks, "a4", "center"));
  });

  it("JSONB 里其它覆盖项不被模版 id 的写入抹掉", async () => {
    const masterId = (await getMasterScriptViewId(prodId))!;
    await getPool().query(`UPDATE script_view SET template_overrides = '{"future": {"x": 1}}'::jsonb WHERE id = $1`, [masterId]);
    await saveScriptConfig(prodId, versionId, { ...DEFAULT_SCRIPT_CONFIG, templateId: "legacy-center@1" });
    const r = await getPool().query<{ o: Record<string, unknown> }>("SELECT template_overrides AS o FROM script_view WHERE id = $1", [masterId]);
    expect(r.rows[0].o).toEqual({ future: { x: 1 }, templateId: "legacy-center@1" });
  });
});

describe("门：版式字段走 script_view/<主本>@edit，其余剧本设置走 scene meta/name@edit", () => {
  let sceneOnly: string;
  let viewEditor: string;

  beforeAll(async () => {
    const mk = async () => (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
    sceneOnly = await mk();
    viewEditor = await mk();
    await addProductionMember(prodId, sceneOnly);
    await addProductionMember(prodId, viewEditor);
    await grant(sceneOnly, "scene", "*", "meta/name", "edit");
    const masterId = (await getMasterScriptViewId(prodId))!;
    await grant(viewEditor, "script_view", masterId, "*", "edit");
    // 基线：owner 把模版置回 null、分隔符置缺省
    await saveScriptConfig(prodId, versionId, { ...DEFAULT_SCRIPT_CONFIG });
  });

  // 客户端每次发的是整份 config（含 loadProduction 自动装配的 openingChapterMarkerId），
  // 测试也按这个形状发：在当前值上打补丁，别让没动的字段被判成「改了」
  const patch = async (p: Record<string, unknown>) => ({ ...(await loadProduction(prodId, versionId))!.state.config, ...p });

  it("只持 scene meta/name@edit：改分隔符 200，改模版 403（库里不变）", async () => {
    expect((await putConfig(await patch({ stageDelimOpen: "[", stageDelimClose: "]" }), sceneOnly)).status).toBe(200);
    expect((await putConfig(await patch({ templateId: "legacy-compact@1" }), sceneOnly)).status).toBe(403);
    expect(await storedTemplateId()).toBeNull();
    expect((await putConfig(await patch({ pageLayout: "letter" }), sceneOnly)).status).toBe(403);
  });

  it("持 script_view/<主本>@edit：改模版 200；顺手改分隔符则 403（那是另一把钥匙）", async () => {
    expect((await putConfig(await patch({ templateId: "legacy-compact@1" }), viewEditor)).status).toBe(200);
    expect(await storedTemplateId()).toBe("legacy-compact@1");
    expect((await putConfig(await patch({ stageDelimOpen: "（", stageDelimClose: "）" }), viewEditor)).status).toBe(403);
  });

  it("什么都没改的整份回写：两把钥匙都不需要（客户端每次发整份 config）", async () => {
    const nobody = (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
    await addProductionMember(prodId, nobody);
    const current = (await loadProduction(prodId, versionId))!.state.config;
    expect((await putConfig({ ...current }, nobody)).status).toBe(200);
  });
});
