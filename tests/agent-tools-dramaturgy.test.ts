import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, makeScene, makeCharacter, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, listMarkerProjectionByVersion, listCharactersByVersion } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { DENIED_NOT_MEMBER } from "@/lib/agent-tools/production-tools";
import {
  dramaturgyPermissions, sceneList, sceneRead, characterList, characterRead,
  runDramaturgyProposal, previewDramaturgyProposal, DRAMATURGY_PROPOSE_TOOLS,
  DENIED_SCENE_VIEW, DENIED_CHARACTER_VIEW,
} from "@/lib/agent-tools/dramaturgy-tools";
import { approvalCard } from "@/lib/agent-runtime/cards";
import { buildTools, bareName } from "@/lib/agent-runtime/tools";

// 构作族的核心保证：一个写工具横跨多把钥匙 → ①权限查询工具给出三态；②写工具按 REST
// 同一套钥匙逐项判定，任一无权整批不动（原子）；③读门 = 页面门票（scene/character meta@view）。

let prodId: string;
let versionId: string;
let ownerId: string;
let plainId: string;      // 成员、零 grant
let editorId: string;     // 成员：scene meta@view + synopsis@edit + character meta@view
let outsiderId: string;
let chapterA: string;
let chapterB: string;
let charId: string;

async function grant(userId: string, type: string, id: string, sub: string, verb: string) {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'direct', $2)`,
    [prodId, userId, type, id, sub, verb]);
}

const idOf = (text: string, name: string): string => {
  const m = new RegExp(`${name}（id: ([^）]+)）`).exec(text);
  if (!m) throw new Error(`no id for ${name} in:\n${text}`);
  return m[1];
};

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  plainId = (await upsertFeishuUser(`test-open-${shortId()}`, `零权限${shortId()}`, null, false)).userId;
  editorId = (await upsertFeishuUser(`test-open-${shortId()}`, `梗概编辑${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
  ({ prodId, versionId } = await makeProduction(ownerId));
  await addProductionMember(prodId, plainId);
  await addProductionMember(prodId, editorId);
  await grant(editorId, "scene", "*", "meta", "view");
  await grant(editorId, "scene", "*", "synopsis", "edit");
  await grant(editorId, "character", "*", "meta", "view");
  chapterA = await makeScene(prodId, versionId, { number: "1", name: "第一章" });
  chapterB = await makeScene(prodId, versionId, { number: "2", name: "第二章" });
  charId = await makeCharacter(prodId, versionId, { name: "老王" });
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("dramaturgy_permissions：三态清单", () => {
  it("所有者：全部可写", async () => {
    const out = await dramaturgyPermissions(ownerId, prodId);
    expect(out).toContain("全部可写");
    expect(out).not.toMatch(/^- [🔓📝⛔]/mu); // 清单行全是 ✅（图例行里的符号不算）
  });

  it("零权限成员：每一项都是需申请，并带出权限键", async () => {
    const out = await dramaturgyPermissions(plainId, prodId);
    expect(out).toContain("📝 新建章节/场次（node:scene/*@create）");
    expect(out).toContain("📝 修改梗概（node:scene/*/synopsis@edit）");
    expect(out).toContain("📝 删除角色（全部）（node:character/*@delete）");
  });

  it("逐字段：持梗概钥匙的人看到 ✅ 梗概、📝 音乐", async () => {
    const out = await dramaturgyPermissions(editorId, prodId);
    expect(out).toContain("✅ 修改梗概");
    expect(out).toContain("📝 修改音乐（node:scene/*/music@edit）");
  });

  it("非成员明确拒绝", async () => {
    expect(await dramaturgyPermissions(outsiderId, prodId)).toBe(DENIED_NOT_MEMBER);
  });
});

describe("读门 = 页面门票", () => {
  it("非成员 / 无 meta@view 的成员分别拒绝，措辞带键", async () => {
    expect(await sceneList(outsiderId, prodId)).toBe(DENIED_NOT_MEMBER);
    expect(await sceneList(plainId, prodId)).toBe(DENIED_SCENE_VIEW);
    expect(await sceneRead(plainId, prodId, chapterA)).toBe(DENIED_SCENE_VIEW);
    expect(await characterList(plainId, prodId)).toBe(DENIED_CHARACTER_VIEW);
    expect(await characterRead(plainId, prodId, charId)).toBe(DENIED_CHARACTER_VIEW);
  });

  it("持门票的成员看到结构树与角色（含 id）", async () => {
    const tree = await sceneList(editorId, prodId);
    expect(tree).toContain(`第一章（id: ${chapterA}）`);
    expect(tree).toContain(`第二章（id: ${chapterB}）`);
    const one = await sceneRead(editorId, prodId, chapterA);
    expect(one).toContain("第一章");
    expect(one).toContain("构作字段均为空");
    const chars = await characterList(editorId, prodId);
    expect(chars).toContain(`老王（id: ${charId}）`);
    expect(await characterRead(editorId, prodId, charId)).toContain("老王");
  });
});

describe("scene_propose_update：逐字段钥匙 + 整批原子", () => {
  it("只持梗概钥匙 → 改梗概成功", async () => {
    const out = await runDramaturgyProposal(editorId, prodId, "production-scene_propose_update", {
      updates: [{ sceneId: chapterA, synopsis: "开场：老王回乡" }], summary: "测试",
    });
    expect(out).toContain("已更新 1 个");
    const scenes = await listMarkerProjectionByVersion(versionId);
    expect(scenes.find((s) => s.id === chapterA)?.synopsis).toBe("开场：老王回乡");
  });

  it("一批里混入无权字段 → 整批拒绝、一个都不改，拒绝文案带缺的键与申请入口", async () => {
    const out = await runDramaturgyProposal(editorId, prodId, "production-scene_propose_update", {
      updates: [{ sceneId: chapterB, synopsis: "第二章梗概" }, { sceneId: chapterA, music: "钢琴" }], summary: "测试",
    });
    expect(out).toContain("权限被拒绝");
    expect(out).toContain("node:scene/*/music@edit");
    expect(out).toContain("/unauthorized?resource=");
    const scenes = await listMarkerProjectionByVersion(versionId);
    expect(scenes.find((s) => s.id === chapterB)?.synopsis).toBe("");
    expect(scenes.find((s) => s.id === chapterA)?.music).toBe("");
  });

  it("预览与执行同一份判定：无权时 hasPermission=false 且 notes 点名缺的钥匙", async () => {
    const p = await previewDramaturgyProposal(editorId, prodId, "production-scene_propose_update", {
      updates: [{ sceneId: chapterA, music: "钢琴" }], summary: "测试",
    });
    expect(p.hasPermission).toBe(false);
    expect(p.notes.some((n) => n.includes("node:scene/*/music@edit"))).toBe(true);
    const ok = await previewDramaturgyProposal(editorId, prodId, "production-scene_propose_update", {
      updates: [{ sceneId: chapterA, synopsis: "x" }], summary: "测试",
    });
    expect(ok.hasPermission).toBe(true);
  });

  it("参数错误（不存在的场次 / 没有字段）是 error，不是权限拒绝", async () => {
    const p = await previewDramaturgyProposal(ownerId, prodId, "production-scene_propose_update", {
      updates: [{ sceneId: "nope" }], summary: "测试",
    });
    expect(p.error).toContain("没有找到场次");
  });
});

describe("scene_propose_create / delete", () => {
  let chapterC: string;
  let sceneC1: string;

  it("所有者：建章、再在章下建场（批量一张卡、一次落库）", async () => {
    const out = await runDramaturgyProposal(ownerId, prodId, "production-scene_propose_create", {
      items: [{ name: "第三章" }], summary: "测试",
    });
    expect(out).toContain("已新建 1 个");
    chapterC = idOf(out, "第三章");
    const out2 = await runDramaturgyProposal(ownerId, prodId, "production-scene_propose_create", {
      items: [{ name: "三之一", parentId: chapterC }, { name: "三之二", parentId: chapterC }], summary: "测试",
    });
    expect(out2).toContain("已新建 2 个");
    sceneC1 = idOf(out2, "三之一");
    const scenes = await listMarkerProjectionByVersion(versionId);
    const c1 = scenes.find((s) => s.id === sceneC1);
    expect(c1?.kind).toBe("scene");
    expect(c1?.parentId).toBe(chapterC);
    expect(scenes.find((s) => s.id === chapterC)?.kind).toBe("chapter");
  });

  it("零权限成员新建 → 拒绝并带 create 键", async () => {
    const out = await runDramaturgyProposal(plainId, prodId, "production-scene_propose_create", {
      items: [{ name: "偷建" }], summary: "测试",
    });
    expect(out).toContain("node:scene/*@create");
    expect((await listMarkerProjectionByVersion(versionId)).some((s) => s.name === "偷建")).toBe(false);
  });

  it("带构作详情的章节不可删（业务规则，非权限）；空场次可删", async () => {
    const blocked = await runDramaturgyProposal(ownerId, prodId, "production-scene_propose_delete", { sceneId: chapterA, summary: "测试" });
    expect(blocked).toContain("无法删除");
    expect(blocked).toContain("这不是权限问题");
    const ok = await runDramaturgyProposal(ownerId, prodId, "production-scene_propose_delete", { sceneId: sceneC1, summary: "测试" });
    expect(ok).toContain("已删除");
    expect((await listMarkerProjectionByVersion(versionId)).some((s) => s.id === sceneC1)).toBe(false);
  });

  it("零权限成员删除 → 拒绝并带实例级 delete 键", async () => {
    const out = await runDramaturgyProposal(plainId, prodId, "production-scene_propose_delete", { sceneId: chapterB, summary: "测试" });
    expect(out).toContain(`node:scene/${chapterB}@delete`);
    expect((await listMarkerProjectionByVersion(versionId)).some((s) => s.id === chapterB)).toBe(true);
  });
});

describe("character_propose_*", () => {
  let xiaoLi: string;

  it("所有者：批量新建（含聚合角色与成员）", async () => {
    const out = await runDramaturgyProposal(ownerId, prodId, "production-character_propose_create", {
      items: [{ name: "众人", isAggregate: true, memberIds: [charId] }, { name: "小李" }], summary: "测试",
    });
    expect(out).toContain("已新建 2 个角色");
    xiaoLi = idOf(out, "小李");
    const chars = await listCharactersByVersion(versionId);
    const crowd = chars.find((c) => c.name === "众人");
    expect(crowd?.isAggregate).toBe(true);
    expect(crowd?.memberIds).toEqual([charId]);
  });

  it("重名 → 参数错误、整批不建", async () => {
    const out = await runDramaturgyProposal(ownerId, prodId, "production-character_propose_create", {
      items: [{ name: "小赵" }, { name: "老王" }], summary: "测试",
    });
    expect(out).toContain("角色名已存在");
    expect((await listCharactersByVersion(versionId)).some((c) => c.name === "小赵")).toBe(false);
  });

  it("所有者：改小传/性别；零权限成员改 → 拒绝并带实例级 edit 键", async () => {
    const out = await runDramaturgyProposal(ownerId, prodId, "production-character_propose_update", {
      updates: [{ charId: xiaoLi, biography: "小李是老王的邻居。", gender: "男" }], summary: "测试",
    });
    expect(out).toContain("已更新 1 个角色");
    const li = (await listCharactersByVersion(versionId)).find((c) => c.id === xiaoLi);
    expect(li?.biography).toBe("小李是老王的邻居。");
    expect(li?.gender).toBe("男");

    const denied = await runDramaturgyProposal(plainId, prodId, "production-character_propose_update", {
      updates: [{ charId: xiaoLi, biography: "改坏" }], summary: "测试",
    });
    expect(denied).toContain(`node:character/${xiaoLi}@edit`);
    expect((await listCharactersByVersion(versionId)).find((c) => c.id === xiaoLi)?.biography).toBe("小李是老王的邻居。");
  });

  it("删除：零权限拒绝；所有者成功", async () => {
    const denied = await runDramaturgyProposal(plainId, prodId, "production-character_propose_delete", { charIds: [xiaoLi], summary: "测试" });
    expect(denied).toContain(`node:character/${xiaoLi}@delete`);
    const ok = await runDramaturgyProposal(ownerId, prodId, "production-character_propose_delete", { charIds: [xiaoLi], summary: "测试" });
    expect(ok).toContain("已删除 1 个角色");
    expect((await listCharactersByVersion(versionId)).some((c) => c.id === xiaoLi)).toBe(false);
  });
});

describe("注册表与卡片", () => {
  it("六个写工具都过确认门、都只在制作会话可用；规划表与注册表同名", () => {
    const tools = buildTools({ userId: "u", productionId: "p" });
    const registered = new Set(tools.map((t) => bareName(t.name)));
    for (const bare of DRAMATURGY_PROPOSE_TOOLS) {
      expect(registered.has(bare), bare).toBe(true);
      expect(tools.find((t) => bareName(t.name) === bare)?.readOnly).toBe(false);
    }
  });

  it("卡片：无权限 → critical，并把三态说明摆进描述", () => {
    const card = approvalCard("production-scene_propose_update", { updates: [{ sceneId: "s1", synopsis: "x" }], summary: "补梗概" }, {
      hasPermission: false,
      notes: ["1 第一章：梗概", "📝 修改梗概：需要申请（node:scene/*/synopsis@edit），申请入口：/unauthorized?resource=x&id=p"],
    });
    expect(card.severity).toBe("critical");
    expect(card.description).toContain("📝 修改梗概");
    expect(card.description).toContain("第一章：梗概");
    expect(card.description).toContain("补梗概");
    const ok = approvalCard("production-character_propose_delete", { charIds: ["c1"], summary: "去重" }, { hasPermission: true, notes: ["小李"] });
    expect(ok.severity).toBe("warning");
    expect(ok.description).toContain("权限齐全");
  });
});
