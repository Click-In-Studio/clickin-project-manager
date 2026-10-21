import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "@/app/api/account/memories/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { selfConfirmResourceGrant } from "@/lib/perm/resource-grant-db";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
let user: string;
let other: string;
let pid: string;
beforeAll(async () => {
  user = (await upsertFeishuUser(`memory-api-${shortId()}`, "API甲", null, false)).userId;
  other = (await upsertFeishuUser(`memory-api-${shortId()}`, "API乙", null, false)).userId;
  ({ prodId: pid } = await makeProduction(user));
});
afterAll(async () => {
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=ANY($1::uuid[])", [[user, other]]);
  await cleanupProduction(pid).catch(() => {});
});
function request(method: "GET" | "PATCH", uid?: string, body?: unknown, project?: string) {
  return new NextRequest(`http://localhost/api/account/memories${project ? `?productionId=${project}` : ""}`, {
    method, headers: { "Content-Type": "application/json", ...(uid ? { Cookie: `${SESSION_COOKIE}=${createSession({ userId: uid, name: "测试", avatarUrl: null, isAdmin: false })}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
describe("个人记忆管理API", () => {
  it("未登录读写401", async () => {
    expect((await GET(request("GET"))).status).toBe(401);
    expect((await PATCH(request("PATCH", undefined, {}))).status).toBe(401);
  });
  it("非成员不能读写项目记忆，项目owner可以管理自己的条目", async () => {
    expect((await GET(request("GET", other, undefined, pid))).status).toBe(403);
    expect((await PATCH(request("PATCH", other, { action: "create", productionId: pid, body: "越权" }))).status).toBe(403);
    expect((await PATCH(request("PATCH", user, { action: "create", productionId: pid, body: "项目内要求" }))).status).toBe(200);
  });
  it("用户身份和编辑状态来自登录会话，传入别人的userId不会越权", async () => {
    const res = await PATCH(request("PATCH", user, { action: "create", body: "先给结论", userId: other, source: "dream", userEdited: false }));
    expect(res.status).toBe(200);
    const { memory } = await res.json();
    expect(memory.entries[0]).toMatchObject({ source: "active", userEdited: true });
    const foreign = await GET(request("GET", other));
    expect((await foreign.json()).memory.entries).toHaveLength(0);
    expect((await PATCH(request("PATCH", other, { action: "delete", id: memory.entries[0].id, revision: 0 }))).status).toBe(403);
  });
  it("仅持一枚项目查看权限也不能读取或修改别人的个人项目条目", async () => {
    await addProductionMember(pid, other);
    await getPool().query("DELETE FROM production_member_grant WHERE production_id=$1 AND user_id=$2", [pid, other]);
    await selfConfirmResourceGrant(other, pid, "material", "*", "view");
    const own = await GET(request("GET", other, undefined, pid));
    expect(own.status).toBe(200);
    expect((await own.json()).memory.entries).toHaveLength(0);
    const foreign = (await (await GET(request("GET", user, undefined, pid))).json()).memory.entries[0];
    expect((await PATCH(request("PATCH", other, { action: "update", productionId: pid, id: foreign.id, revision: 0, body: "越权修改" }))).status).toBe(403);
  });
  it("错误参数400，陈旧编辑409，编辑与删除推进历史边界", async () => {
    expect((await PATCH(request("PATCH", user, { action: "create", body: "" }))).status).toBe(400);
    const { memory } = await (await GET(request("GET", user))).json();
    const e = memory.entries[0];
    expect((await PATCH(request("PATCH", user, { action: "update", id: e.id, revision: e.revision, body: "先给结论然后说明" }))).status).toBe(200);
    expect((await PATCH(request("PATCH", user, { action: "update", id: e.id, revision: e.revision, body: "旧修改" }))).status).toBe(409);
    const deleted = await PATCH(request("PATCH", user, { action: "delete", id: e.id, revision: e.revision+1 }));
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).memory).toMatchObject({ entries: [], deletedEntries: [expect.objectContaining({ id: e.id })], historyCutoff: expect.any(String) });
  });
});
