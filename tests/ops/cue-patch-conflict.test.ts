import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { makeProduction, makeBlocks, cleanupProduction, shortId } from "../_support/factories";
import { TEST_USER } from "../_support/helpers";
import { createCue, getCue, deleteCue, updateCue, updateCueConditionally } from "@/lib/ops/cue-db";
import { createCueList } from "@/lib/ops/cue-list-db";
import { buildCuePatchBasis, CuePatchConflict, type CueFieldPatch } from "@/lib/ops/cue-edit-types";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { PATCH } from "@/app/api/production/[id]/cuelists/[cueListId]/cues/[cueId]/route";
import type { Cue } from "@/lib/ops/cue-types";

let prodId: string, versionId: string, listId: string, cueId: string, blockIds: string[];
let nonMemberId: string, unrelatedId: string;
let base: Cue;
beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  blockIds = await makeBlocks(prodId, versionId, 2);
  listId = `cl-${shortId()}`;
  await createCueList({ id: listId, productionId: prodId, name: "弱网竞争", notes: "", abbr: null, template: null, createdBy: TEST_USER });
  nonMemberId = (await upsertFeishuUser(`cue-non-${shortId()}`, "非成员", null, false)).userId;
  unrelatedId = (await upsertFeishuUser(`cue-unrelated-${shortId()}`, "单枚无关键", null, false)).userId;
  await addProductionMember(prodId, unrelatedId);
  await getPool().query(`INSERT INTO production_member_grant
    (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
    VALUES ($1, $2, 'cue_list', $3, 'meta', 'view', 'direct', $2)`, [prodId, unrelatedId, listId]);
});
beforeEach(async () => {
  cueId = `cue-${shortId()}`;
  const anchor = { kind: "block" as const, blockId: blockIds[0], offset: 0 };
  await createCue({ id: cueId, cueListId: listId, number: "1", name: "原名称", content: "原内容", start: anchor, end: anchor, versionId });
  base = (await getCue(cueId, listId))!;
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1::text[])", [[nonMemberId, unrelatedId]]).catch(() => {});
});
const read = () => getCue(cueId, listId);
const save = (fields: CueFieldPatch, basisCue = base) => updateCueConditionally(cueId, listId, fields, buildCuePatchBasis(basisCue, fields), versionId);
function send(body: unknown, userId: string | null = TEST_USER) {
  return PATCH(new NextRequest(`http://localhost/api/production/${prodId}/cuelists/${listId}/cues/${cueId}?v=${versionId}`, {
    method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...(userId ? {
      Cookie: `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`,
    } : {}) },
  }), { params: Promise.resolve({ id: prodId, cueListId: listId, cueId }) });
}

describe("Cue 条件保存的真实数据库竞争", () => {
  it("无竞争编辑正常保存，重复请求确认已达目标", async () => {
    const saved = await save({ name: " 新名称 " });
    expect(saved.cue.name).toBe("新名称");
    expect((await save({ name: "新名称" })).cue.name).toBe("新名称");
  });
  it("同一旧依据的并发编辑只有一笔成功", async () => {
    const results = await Promise.allSettled([save({ name: "甲" }), save({ name: "乙" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CuePatchConflict);
    expect(["甲", "乙"]).toContain((await read())!.name);
  });
  it("陈旧写入被拒绝且不部分写入其他字段", async () => {
    await save({ name: "线上新名称" });
    await expect(save({ name: "旧草稿", content: "不能部分写入" })).rejects.toBeInstanceOf(CuePatchConflict);
    expect(await read()).toMatchObject({ name: "线上新名称", content: "原内容" });
  });
  it("其他字段改动不阻止当前字段保存", async () => {
    await save({ name: "线上新名称" });
    await save({ content: "本地新内容" });
    expect(await read()).toMatchObject({ name: "线上新名称", content: "本地新内容" });
  });
  it("写入成功但响应丢失，别人随后修改时旧重试不能覆盖", async () => {
    const first = await save({ name: "曾保存的名称" });
    await save({ name: "后来修改" }, first.cue);
    await expect(save({ name: "曾保存的名称" })).rejects.toBeInstanceOf(CuePatchConflict);
    expect((await read())!.name).toBe("后来修改");
  });
  it("Cue 已删除时不能静默宣告保存成功", async () => {
    await deleteCue(cueId, listId);
    await expect(save({ name: "旧编辑" })).rejects.toBeInstanceOf(CuePatchConflict);
  });
  it("锚点成组核对：别人改变结束点后不能写旧开始点", async () => {
    await save({ end: { kind: "block", blockId: blockIds[1], offset: 0 } });
    await expect(save({ start: { kind: "gap", afterBlockId: null } })).rejects.toBeInstanceOf(CuePatchConflict);
    expect((await read())!.start).toEqual(base.start);
  });
  it("已确认的锚点重试幂等，不触发额外警告通知", async () => {
    const fields = { start: { kind: "gap" as const, afterBlockId: null }, end: { kind: "gap" as const, afterBlockId: null }, warning: true };
    expect((await save(fields)).warningNewlySet).toBe(true);
    expect((await save(fields)).warningNewlySet).toBe(false);
  });
  it("等待行锁的旧请求在检查时看到先提交的新值", async () => {
    const holder = await getPool().connect();
    await holder.query("BEGIN");
    try {
      await holder.query("SELECT id FROM cue WHERE id = $1 FOR UPDATE", [cueId]);
      const pending = save({ name: "等待中的旧编辑" });
      await holder.query("UPDATE cue SET name = '先完成的新编辑' WHERE id = $1", [cueId]);
      await holder.query("COMMIT");
      await expect(pending).rejects.toBeInstanceOf(CuePatchConflict);
      expect((await read())!.name).toBe("先完成的新编辑");
    } finally { await holder.query("ROLLBACK"); holder.release(); }
  });
  it("其他站内写入也不能被旧浏览器依据覆盖", async () => {
    await updateCue(cueId, listId, { name: "站内写入" }, versionId);
    await expect(save({ name: "旧浏览器编辑" })).rejects.toBeInstanceOf(CuePatchConflict);
    expect((await read())!.name).toBe("站内写入");
  });
});

describe("Cue PATCH 契约与权限边界", () => {
  it("未登录 401，非成员与只持 meta view 均 403", async () => {
    const body = { name: "不应写入", basis: { name: base.name } };
    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, nonMemberId)).status).toBe(403);
    expect((await send(body, unrelatedId)).status).toBe(403);
    expect((await read())!.name).toBe(base.name);
  });
  it("缺少旧依据的旧客户端直接 409，不保留无条件写入口", async () => {
    expect((await send({ name: "不应写入" })).status).toBe(409);
    expect((await send({ name: "不应写入", basis: {} })).status).toBe(409);
    expect((await read())!.name).toBe(base.name);
  });
  it("成功回事务确认的 Cue；竞争回 409 并保留线上新值", async () => {
    const body = { name: "线上新名称", basis: { name: base.name } };
    const saved = await send(body);
    expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ ok: true, cue: { id: cueId, name: "线上新名称" } });
    const conflict = await send({ name: "旧草稿", basis: { name: base.name } });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: "CUE_PATCH_CONFLICT" });
    expect((await read())!.name).toBe("线上新名称");
  });
});
