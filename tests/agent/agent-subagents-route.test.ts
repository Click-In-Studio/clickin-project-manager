import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/agent/subagents/route";
import { GET as events } from "@/app/api/agent/subagents/events/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { queueSubagent } from "@/lib/agent/runtime/subagent-db";
import { newRunId } from "@/lib/agent/runtime/ids";
import { getPool } from "@/lib/pg";
import { addProductionMember } from "@/lib/perm/member-db";
import {
  makeProduction,
  cleanupProduction,
  setProductionTier,
  shortId,
} from "../_support/factories";

import { countKickableStreams, kickUserStreams } from "@/lib/sse-kick";

let owner: string;
let outsider: string;
let member: string;
let prodId: string;
let parent: string;
let outsiderParent: string;
let child: string;
beforeAll(async () => {
  owner = (
    await upsertFeishuUser(`sa-route-${shortId()}`, "委托者", null, false)
  ).userId;
  outsider = (
    await upsertFeishuUser(`sa-route-${shortId()}`, "非成员", null, false)
  ).userId;
  member = (
    await upsertFeishuUser(`sa-route-${shortId()}`, "单枚键成员", null, false)
  ).userId;
  ({ prodId } = await makeProduction(owner));
  await setProductionTier(prodId, "pro");
  await addProductionMember(prodId, member);
  await getPool().query(
    "INSERT INTO production_member_grant(production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source) VALUES($1,$2,'production','*','meta','view','direct') ON CONFLICT DO NOTHING",
    [prodId, member],
  );
  parent = createNewSessionKey(owner, prodId);
  outsiderParent = createNewSessionKey(outsider, prodId);
  await PgSessionStorage.create({
    id: parent,
    userId: owner,
    productionId: prodId,
  });
  await PgSessionStorage.create({
    id: outsiderParent,
    userId: outsider,
    productionId: prodId,
  });
  const runId = newRunId();
  await getPool().query(
    "INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')",
    [runId, parent],
  );
  child = await queueSubagent({
    parentSessionId: parent,
    parentRunId: runId,
    task: "阅读剧本",
    message: "找证据",
  });
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});
function req(
  userId: string | null,
  key = parent,
  id?: string,
  method = "GET",
  signal?: AbortSignal,
) {
  const url = `http://localhost/api/agent/subagents?sessionKey=${encodeURIComponent(key)}${id ? `&subagentId=${id}` : ""}`;
  const cookie = userId
    ? `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`
    : "";
  return new NextRequest(url, {
    method,
    signal,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(method === "POST"
      ? { body: JSON.stringify({ sessionKey: key, subagentId: id }) }
      : {}),
  });
}
describe("子助理查看、轨迹、停止与状态流权限", () => {
  for (const [label, handler] of [
    ["列表", GET],
    ["停止", POST],
    ["状态流", events],
  ] as const) {
    const method = label === "停止" ? "POST" : "GET";
    it(`${label} 未登录401`, async () =>
      expect((await handler(req(null, parent, child, method))).status).toBe(
        401,
      ));
    it(`${label} 非成员自己的制作会话403`, async () =>
      expect(
        (await handler(req(outsider, outsiderParent, child, method))).status,
      ).toBe(403));
    it(`${label} 仅持一枚项目键也不能读写他人子任务403`, async () =>
      expect((await handler(req(member, parent, child, method))).status).toBe(
        403,
      ));
  }
  it("所有者只列本会话子任务，结果接口拒绝其他会话 id", async () => {
    const result = await GET(req(owner));
    expect(result.status).toBe(200);
    expect((await result.json()).subagents[0].id).toBe(child);
    const key = createNewSessionKey(owner, prodId);
    await PgSessionStorage.create({
      id: key,
      userId: owner,
      productionId: prodId,
    });
    expect((await GET(req(owner, key, child))).status).toBe(403);
    expect((await POST(req(owner, key, child, "POST"))).status).toBe(403);
  });
  it("状态流首帧包含排队事实，断开会清理订阅", async () => {
    const abort = new AbortController();
    const response = await events(
      req(owner, parent, undefined, "GET", abort.signal),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain("queued");
    abort.abort();
    await reader.cancel();
  });
  it("项目收权可踢断子任务状态流，清掉订阅和注册", async () => {
    const response = await events(req(owner));
    const reader = response.body!.getReader();
    await reader.read();
    expect(countKickableStreams(prodId, owner)).toBe(1);
    expect(kickUserStreams(prodId, owner)).toBe(1);
    expect((await reader.read()).done).toBe(true);
    expect(countKickableStreams(prodId, owner)).toBe(0);
  });
  it("所有者可停止排队项", async () => {
    expect((await POST(req(owner, parent, child, "POST"))).status).toBe(200);
    expect((await GET(req(owner))).status).toBe(200);
    expect((await (await GET(req(owner))).json()).subagents[0].status).toBe(
      "stopped",
    );
  });
});
