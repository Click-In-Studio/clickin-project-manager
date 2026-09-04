import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createWiki, addWikiSharePerson, getWiki } from "@/lib/wiki/content";
import { listWikiDeptShares } from "@/lib/wiki/tree";
import { createProductionDept, setDeptMembers } from "@/lib/dept-db";
import { canViewWiki } from "@/lib/wiki/perm";
import { resolveProductionActor, DENIED_NOT_MEMBER } from "@/lib/agent-tools/production-tools";
import { wikiSetGrant, sharePermissionKey } from "@/lib/agent-tools/wiki-tools";

// 分享面写工具的核心保证：门是 grants@edit（能改正文 ≠ 能改谁看得见），
// 且改完之后可见性是真的变了（AI 视角 = 人类视角，判定走同一份 canViewWiki）。

let prodId: string;
let ownerId: string;
let editorId: string;   // 有 *@edit（可编辑正文），无 grants@edit
let plainId: string;    // 零权限成员
let outsiderId: string; // 非成员
let deptId: string;
let groupId: string;
let wikiId: string;

async function canSee(userId: string, id = wikiId): Promise<boolean> {
  const resolved = await resolveProductionActor(userId, prodId);
  if (!resolved) return false;
  return canViewWiki(resolved.actor, prodId, id);
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  editorId = (await upsertFeishuUser(`test-open-${shortId()}`, `编辑者${shortId()}`, null, false)).userId;
  plainId = (await upsertFeishuUser(`test-open-${shortId()}`, `零权限${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, editorId);
  await addProductionMember(prodId, plainId);

  const dept = await createProductionDept({ productionId: prodId, name: `灯光部${shortId()}` });
  deptId = dept.id;
  await setDeptMembers(deptId, prodId, [{ userId: plainId, isPoc: false }]);
  const group = await createProductionDept({ productionId: prodId, name: `选人组${shortId()}`, kind: "group" });
  groupId = group.id;

  const doc = await createWiki({ productionId: prodId, title: "私有文档", body: "机密正文", createdBy: ownerId });
  wikiId = doc.id;
  // editorId 拿 edit 档行集（*@edit，不含 grants@edit）——刻意造出"能改正文
  // 但不该能改分享设置"的成员
  await addWikiSharePerson(wikiId, prodId, { userId: editorId, level: "edit", confirmedBy: ownerId });
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("权限门（分享面 = grants@edit，与编辑门分离）", () => {
  it("非成员一律明确拒绝", async () => {
    expect(await wikiSetGrant(outsiderId, prodId, { wikiId, isPublic: true, summary: "测试" }))
      .toBe(DENIED_NOT_MEMBER);
  });

  it("零权限成员被拒，且回给可申请的权限键", async () => {
    const out = await wikiSetGrant(plainId, prodId, { wikiId, isPublic: true, summary: "测试" });
    expect(out).toContain("权限被拒绝");
    expect(out).toContain(sharePermissionKey(wikiId));
    expect((await getWiki(wikiId, prodId))?.isPublic).toBe(false); // 一个字段都没改
  });

  it("有 *@edit 但没有 grants@edit 的成员改不了分享设置", async () => {
    expect(await canSee(editorId)).toBe(true); // 他确实能看/能编辑这篇
    const out = await wikiSetGrant(editorId, prodId, { wikiId, isPublic: true, summary: "测试" });
    expect(out).toContain("权限被拒绝");
    expect((await getWiki(wikiId, prodId))?.isPublic).toBe(false);
  });

  it("不存在的文档 → 找不到（不泄露权限判定）", async () => {
    const out = await wikiSetGrant(ownerId, prodId, {
      wikiId: "00000000-0000-0000-0000-000000000000", isPublic: true, summary: "测试",
    });
    expect(out).toBe("没有找到该文档。");
  });
});

describe("三个分享面真的生效（可见性判定走同一份 canViewWiki）", () => {
  it("单独分享给某人 → 对方看得见；撤销 → 看不见", async () => {
    expect(await canSee(plainId)).toBe(false);

    const added = await wikiSetGrant(ownerId, prodId, {
      wikiId, addPeople: [{ userId: plainId, level: "view" }], summary: "他要参与这块",
    });
    expect(added).toContain("已把文档分享给");
    expect(await canSee(plainId)).toBe(true);

    const removed = await wikiSetGrant(ownerId, prodId, {
      wikiId, removePeopleUserIds: [plainId], summary: "他不参与了",
    });
    expect(removed).toContain("已撤销");
    expect(await canSee(plainId)).toBe(false);
  });

  it("分享给部门 → 部门成员看得见；传空数组 = 清空（整体替换）", async () => {
    await wikiSetGrant(ownerId, prodId, { wikiId, deptIds: [deptId], summary: "整个灯光部要看" });
    expect(await listWikiDeptShares(wikiId)).toEqual([deptId]);
    expect(await canSee(plainId)).toBe(true);

    await wikiSetGrant(ownerId, prodId, { wikiId, deptIds: [], summary: "收回" });
    expect(await listWikiDeptShares(wikiId)).toEqual([]);
    expect(await canSee(plainId)).toBe(false);
  });

  it("全体可见开关 → 零权限成员也看得见；关掉即收缩", async () => {
    await wikiSetGrant(ownerId, prodId, { wikiId, isPublic: true, summary: "公开" });
    expect((await getWiki(wikiId, prodId))?.isPublic).toBe(true);
    expect(await canSee(plainId)).toBe(true);

    await wikiSetGrant(ownerId, prodId, { wikiId, isPublic: false, summary: "收回" });
    expect(await canSee(plainId)).toBe(false);
  });

  it("manage 档的被分享人可以再分享（grants@edit 随档位发行）", async () => {
    await wikiSetGrant(ownerId, prodId, {
      wikiId, addPeople: [{ userId: editorId, level: "manage" }], summary: "交给他管",
    });
    const out = await wikiSetGrant(editorId, prodId, {
      wikiId, addPeople: [{ userId: plainId, level: "view" }], summary: "带上他",
    });
    expect(out).not.toContain("权限被拒绝");
    expect(await canSee(plainId)).toBe(true);

    await wikiSetGrant(ownerId, prodId, { wikiId, removePeopleUserIds: [plainId], summary: "复原" });
  });
});

describe("入参校验：宁可一条都不改，也不留半套分享设置", () => {
  it("未知部门 id → 整单拒绝，其余字段也不落库", async () => {
    const out = await wikiSetGrant(ownerId, prodId, {
      wikiId, isPublic: true, deptIds: ["00000000-0000-0000-0000-000000000000"], summary: "测试",
    });
    expect(out).toContain("不是本制作的部门");
    expect((await getWiki(wikiId, prodId))?.isPublic).toBe(false);
  });

  it("用户组 id 不能当部门分享（人类界面的部门栏也只列部门）", async () => {
    const out = await wikiSetGrant(ownerId, prodId, { wikiId, deptIds: [groupId], summary: "测试" });
    expect(out).toContain("用户组");
    expect(await listWikiDeptShares(wikiId)).toEqual([]);
  });

  it("同一个人既加又删 → 意图不明，整单拒绝", async () => {
    const out = await wikiSetGrant(ownerId, prodId, {
      wikiId, isPublic: true,
      addPeople: [{ userId: plainId, level: "view" }], removePeopleUserIds: [plainId], summary: "测试",
    });
    expect(out).toContain("无法判断意图");
    expect((await getWiki(wikiId, prodId))?.isPublic).toBe(false);
    expect(await canSee(plainId)).toBe(false);
  });

  it("分享对象不是本项目成员 → 该条不生效，明确报出来", async () => {
    const out = await wikiSetGrant(ownerId, prodId, {
      wikiId, addPeople: [{ userId: outsiderId, level: "view" }], summary: "测试",
    });
    expect(out).toContain("对方不是本项目成员");
    expect(await canSee(outsiderId)).toBe(false);
  });

  it("什么都不传 → 不报错，回读当前分享设置", async () => {
    const out = await wikiSetGrant(ownerId, prodId, { wikiId, summary: "看看现状" });
    expect(out).toContain("没有提供任何要修改的分享设置");
    expect(out).toContain("当前分享设置");
    expect(out).toContain("全体成员可见：否");
  });
});
