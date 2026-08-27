/**
 * 角色 / 场次写面：前端门与判定端路由门同键（PR #359）。
 *
 * 病：前端拿一枚粗门开多个写入口，判定端却是逐动作各查各的键。
 *   - 角色页用 `character/*@edit` 一枚开「添加 / 行内编辑 / 删除」三个入口，
 *     后端是 create / edit / delete 三条路由门；
 *   - 构作页用 `SceneFieldPerms.any` 开「新建 / 删除 / 转换类型」，
 *     后端是 create / delete / meta-type@edit。
 * 双向出错：只持 create 的人看不见「添加」；只持 synopsis@edit 的人看得见一整排
 * 必然 403 的按钮。持全集的人（模板发的正是全集）身上永远不显形，所以线上没炸。
 *
 * 四层：
 *   ① 纯函数层：折行成门——单枚键互不蕴含、粗门不蕴含具体动词、实例级行只覆盖自己
 *   ② 判定层：真打库，钉住 WHERE 子句（类型过滤 / is_revoked / expires_at / 实例行）
 *   ③ 路由层：直接打 POST handler。bug 在 wiring 上——换错函数、传错参数都要红
 *   ④ 棘轮层：这些写面键必须在激活面目录里，否则持区间者永远激活不出行
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST as postCharacter } from "@/app/api/production/[id]/characters/route";
import { POST as postScene } from "@/app/api/production/[id]/scenes/route";
import {
  characterPermsFromRows,
  canEditCharacter,
  canDeleteCharacter,
  getCharacterPerms,
  ALL_CHARACTER_PERMS,
  NO_CHARACTER_PERMS,
} from "@/lib/character-perms";
import {
  sceneFieldPermsFromRows,
  canDeleteScene,
  getSceneFieldPerms,
} from "@/lib/scene-field-perms";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { getPool } from "@/lib/pg";
import { createProductionDept, setDeptMembers } from "@/lib/dept-db";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// ── ① 纯函数层 ────────────────────────────────────────────────────────────────

const row = (sub: string, verb: string, id = "*") =>
  ({ resource_id: id, resource_sub: sub, permission_level: verb });

describe("character 三枚键互不蕴含", () => {
  it("只有 create：看得见「添加」，看不见行内编辑与删除", () => {
    const p = characterPermsFromRows([row("*", "create")]);
    expect([p.create, p.edit, p.delete]).toEqual([true, false, false]);
    expect(p.any).toBe(true);
  });

  it("只有 edit：看得见行内编辑，看不见「添加」与「删除」", () => {
    const p = characterPermsFromRows([row("*", "edit")]);
    expect([p.create, p.edit, p.delete]).toEqual([false, true, false]);
  });

  it("只有 delete：只看得见「删除」", () => {
    const p = characterPermsFromRows([row("*", "delete")]);
    expect([p.create, p.edit, p.delete]).toEqual([false, false, true]);
  });

  it("模板发的全集三枚齐活；无行则三枚全无", () => {
    expect(characterPermsFromRows([row("*", "create"), row("*", "edit"), row("*", "delete")]))
      .toEqual(ALL_CHARACTER_PERMS);
    expect(characterPermsFromRows([])).toEqual(NO_CHARACTER_PERMS);
  });

  it("字段级 view 行不喂任何写面开关", () => {
    expect(characterPermsFromRows([row("meta", "view"), row("biography", "view")]))
      .toEqual(NO_CHARACTER_PERMS);
  });

  it("实例级行只覆盖它自己那一个角色（判定端 PATCH/DELETE 查 id IN (charId,'*')）", () => {
    const p = characterPermsFromRows([row("*", "edit", "cA"), row("*", "delete", "cB")]);
    expect(p.edit).toBe(false);
    expect(canEditCharacter(p, "cA")).toBe(true);
    expect(canEditCharacter(p, "cB")).toBe(false);
    expect(canDeleteCharacter(p, "cB")).toBe(true);
    expect(canDeleteCharacter(p, "cA")).toBe(false);
    expect(p.any).toBe(true);
  });

  it("域级行覆盖全部角色", () => {
    const p = characterPermsFromRows([row("*", "edit")]);
    expect(canEditCharacter(p, "任意角色")).toBe(true);
  });
});

describe("scene：any 是粗门，不蕴含 create / delete / kind", () => {
  it("只持 synopsis@edit —— any 为真，但新建 / 删除 / 转换类型全假", () => {
    const p = sceneFieldPermsFromRows([row("synopsis", "edit")]);
    expect(p.any).toBe(true);
    expect(p.synopsis).toBe(true);
    expect([p.create, p.delete, p.kind]).toEqual([false, false, false]);
  });

  it("scene/*@create 不顺带给出 edit 类的字段门", () => {
    const p = sceneFieldPermsFromRows([row("*", "create")]);
    expect(p.create).toBe(true);
    expect([p.delete, p.structure, p.name, p.kind]).toEqual([false, false, false, false]);
  });

  it("sub 通配行覆盖全部字段门，但不蕴含 create / delete", () => {
    const p = sceneFieldPermsFromRows([row("*", "edit")]);
    expect([p.name, p.kind, p.music, p.structure]).toEqual([true, true, true, true]);
    expect([p.create, p.delete]).toEqual([false, false]);
  });

  it("实例级 delete 只覆盖它自己那一场（字段 PATCH 判定端只查 '*'，故只有 delete 有这一层）", () => {
    const p = sceneFieldPermsFromRows([row("*", "delete", "s1")]);
    expect(p.delete).toBe(false);
    expect(canDeleteScene(p, "s1")).toBe(true);
    expect(canDeleteScene(p, "s2")).toBe(false);
    expect(p.any).toBe(true);
  });

  it("实例级行不点亮字段门——判定端字段 PATCH 查的是 resource_id='*'", () => {
    const p = sceneFieldPermsFromRows([row("synopsis", "edit", "s1"), row("*", "edit", "s1")]);
    expect([p.synopsis, p.structure, p.name]).toEqual([false, false, false]);
  });
});

// ── ②③ 判定层 + 路由层（打库） ─────────────────────────────────────────────────

let prodId: string;
let ownerId: string;   // 演出 owner —— 验旁路
let rowUserId: string; // 持 grant 行
let zoneUserId: string;// 只持 dept 区间（未激活）
let noneUserId: string;// 项目成员，无任何资格
let permsUserId: string;// 只用于 ② 层的行折叠断言
let outsiderId: string;// 非成员

const allUsers = () =>
  [ownerId, rowUserId, zoneUserId, noneUserId, permsUserId, outsiderId].filter(Boolean);

async function makeUser(tag: string): Promise<string> {
  const u = await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false);
  return u.userId;
}

async function giveRow(
  userId: string, type: string, verb: string,
  opts: { id?: string; sub?: string; revoked?: boolean; expiresAt?: string } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, is_revoked, revoked_reason, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'auto', $7, $8, $9)`,
    [prodId, userId, type, opts.id ?? "*", opts.sub ?? "*", verb,
     opts.revoked ?? false, opts.revoked ? "manual" : null, opts.expiresAt ?? null],
  );
}

async function giveDeptZoneKey(deptId: number | string, key: string): Promise<void> {
  await getPool().query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
     VALUES ($1, $2, $3) ON CONFLICT (dept_id, permission_key) DO NOTHING`,
    [prodId, deptId, key],
  );
}

function makeReq(path: string, userId: string | null, body: unknown): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userId) {
    headers.Cookie =
      `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  }
  return new NextRequest(`http://localhost/api/production/${prodId}/${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

const routeCtx = () => ({ params: Promise.resolve({ id: prodId }) });

beforeAll(async () => {
  ownerId    = await makeUser("owner");
  rowUserId  = await makeUser("持行");
  zoneUserId = await makeUser("持区间");
  noneUserId = await makeUser("无资格");
  permsUserId = await makeUser("折叠断言");
  outsiderId = await makeUser("非成员");

  ({ prodId } = await makeProduction(ownerId));
  for (const u of [rowUserId, zoneUserId, noneUserId, permsUserId]) {
    await addProductionMember(prodId, u);
  }

  await giveRow(rowUserId, "character", "create");
  await giveRow(rowUserId, "scene", "create");

  const zoneDept = await createProductionDept({ productionId: prodId, name: `zone-${shortId()}` });
  await setDeptMembers(zoneDept.id, prodId, [{ userId: zoneUserId, isPoc: false }]);
  await giveDeptZoneKey(zoneDept.id, "node:character/*@create");
  await giveDeptZoneKey(zoneDept.id, "node:scene/*@create");
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("② getCharacterPerms / getSceneFieldPerms 的 WHERE 子句", () => {
  it("bypass 直接给全集，不查库", async () => {
    expect(await getCharacterPerms(permsUserId, prodId, true)).toEqual(ALL_CHARACTER_PERMS);
  });

  it("只认本类型的行——scene 的 create 不会漏进 character 快照", async () => {
    await giveRow(permsUserId, "scene", "create");
    expect(await getCharacterPerms(permsUserId, prodId, false)).toEqual(NO_CHARACTER_PERMS);
  });

  it("撤销行与过期行都不算数", async () => {
    await giveRow(permsUserId, "character", "edit", { revoked: true });
    await giveRow(permsUserId, "character", "delete", { expiresAt: "2000-01-01T00:00:00Z" });
    const p = await getCharacterPerms(permsUserId, prodId, false);
    expect([p.edit, p.delete]).toEqual([false, false]);
  });

  it("未过期的有效期行算数", async () => {
    await giveRow(permsUserId, "character", "create", { expiresAt: "2999-01-01T00:00:00Z" });
    expect((await getCharacterPerms(permsUserId, prodId, false)).create).toBe(true);
  });

  it("实例级行进 editIds / deleteIds，不进域级 edit / delete", async () => {
    await giveRow(permsUserId, "character", "edit", { id: "charX" });
    await giveRow(permsUserId, "scene", "delete", { id: "sceneX" });
    const cp = await getCharacterPerms(permsUserId, prodId, false);
    expect(cp.edit).toBe(false);
    expect(cp.editIds).toEqual(["charX"]);
    const sp = await getSceneFieldPerms(permsUserId, prodId, false);
    expect(sp.delete).toBe(false);
    expect(canDeleteScene(sp, "sceneX")).toBe(true);
  });
});

describe("③ POST /characters 与 POST /scenes 的 create 门", () => {
  it("未登录 → 401", async () => {
    const res = await postCharacter(makeReq("characters", null, { name: "甲" }), routeCtx());
    expect(res.status).toBe(401);
  });

  it("非本项目成员 → 403 无权访问", async () => {
    const res = await postCharacter(makeReq("characters", outsiderId, { name: "甲" }), routeCtx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("无权访问");
  });

  it("owner 旁路（六步链第 1 步）→ 201", async () => {
    const res = await postCharacter(
      makeReq("characters", ownerId, { name: `owner建-${shortId()}` }), routeCtx());
    expect(res.status).toBe(201);
    const scene = await postScene(
      makeReq("scenes", ownerId, { name: `owner建章-${shortId()}` }), routeCtx());
    expect(scene.status).toBe(201);
  });

  it("持 grant 行 → 201", async () => {
    const res = await postCharacter(
      makeReq("characters", rowUserId, { name: `持行建-${shortId()}` }), routeCtx());
    expect(res.status).toBe(201);
    const scene = await postScene(
      makeReq("scenes", rowUserId, { name: `持行建章-${shortId()}` }), routeCtx());
    expect(scene.status).toBe(201);
  });

  it("只持区间未激活 → 403「请先确认创建权限」（裸 hasGrant 时只会给无指向的「权限不足」）", async () => {
    const res = await postCharacter(makeReq("characters", zoneUserId, { name: "乙" }), routeCtx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("请先确认创建权限");
    const scene = await postScene(makeReq("scenes", zoneUserId, { name: "第二章" }), routeCtx());
    expect(scene.status).toBe(403);
    expect((await scene.json()).error).toBe("请先确认创建权限");
  });

  it("成员但毫无资格 → 403 权限不足", async () => {
    const res = await postCharacter(makeReq("characters", noneUserId, { name: "丙" }), routeCtx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("权限不足");
    const scene = await postScene(makeReq("scenes", noneUserId, { name: "第三章" }), routeCtx());
    expect(scene.status).toBe(403);
    expect((await scene.json()).error).toBe("权限不足");
  });

  it("create 与 edit 不互相蕴含：只持 edit 的人建不了角色", async () => {
    await giveRow(noneUserId, "character", "edit");
    const res = await postCharacter(makeReq("characters", noneUserId, { name: "丁" }), routeCtx());
    expect(res.status).toBe(403);
  });
});

// ── ④ 棘轮层 ──────────────────────────────────────────────────────────────────

describe("④ 激活面收齐了这些写面键", () => {
  it("character 三枚都在 characters scope 里（否则持区间者永远激活不出行）", () => {
    for (const verb of ["create", "edit", "delete"]) {
      expect(PAGE_PERMISSION_SCOPES.characters.has(`node:character/*@${verb}`)).toBe(true);
    }
  });

  it("scene 的 create / edit / delete 都在 dramaturgy scope 里", () => {
    for (const verb of ["create", "edit", "delete"]) {
      expect(PAGE_PERMISSION_SCOPES.dramaturgy.has(`node:scene/*@${verb}`)).toBe(true);
    }
  });
});
