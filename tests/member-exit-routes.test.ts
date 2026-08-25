/**
 * 成员状态机路由层测试（route handler 直调，不起 HTTP server）。
 *
 * 与 member-exit.test.ts 的分工：那边测 lib 层的状态机语义，这边只测**路由自己
 * 的那几行**——四个门的边界。这些分支在 lib 测试里一条也走不到，而它们正是这个
 * 端点的全部风险所在：谁能替谁退出、谁能把访问权还回去。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { addProductionMember, upsertFeishuUser } from "@/lib/db";
import { getMemberStatus, restoreMember } from "@/lib/member-status";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

import { POST as statusHandler, GET as statusGet } from
  "@/app/api/production/[id]/members/[userId]/status/route";

let prodId: string;
let ownerId: string;
let memberA: string;
let memberB: string;
let outsider: string;

function session(userId: string) {
  return createSession({ userId, name: "路由测试用户", avatarUrl: null, isAdmin: false });
}

function req(opts: { session?: string; method?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest("http://localhost/api/member-status", {
    method: opts.method ?? "POST",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers,
  });
}

// 路由 handler 的 params 形状各异，any 避免结构性不匹配的假报错
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

async function post(actor: string, subject: string, body: unknown) {
  return statusHandler(
    req({ session: session(actor), body }),
    ctx({ id: prodId, userId: subject }),
  );
}

beforeAll(async () => {
  const mk = async (label: string) =>
    (await upsertFeishuUser(`test-open-${shortId()}`, `${label}${shortId()}`, null, false)).userId;
  ownerId = await mk("退出路由owner");
  memberA = await mk("退出路由甲");
  memberB = await mk("退出路由乙");
  outsider = await mk("退出路由外人");

  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
  await addProductionMember(prodId, memberA);
  await addProductionMember(prodId, memberB);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("入参", () => {
  it("未知 action 一律 400", async () => {
    const res = await post(memberA, memberA, { action: "leave" });
    expect(res.status).toBe(400);
  });

  it("未登录 401", async () => {
    const res = await statusHandler(
      req({ body: { action: "self_exit" } }),
      ctx({ id: prodId, userId: memberA }),
    );
    expect(res.status).toBe(401);
  });
});

describe("自助退出门", () => {
  it("不能替别人发起退出", async () => {
    const res = await post(memberA, memberB, { action: "self_exit" });
    expect(res.status).toBe(403);
    expect((await getMemberStatus(prodId, memberB))?.status).toBe("active");
  });

  it("非成员发起退出 403", async () => {
    const res = await post(outsider, outsider, { action: "self_exit" });
    expect(res.status).toBe(403);
  });

  it("本人退出：不需要任何 member 门", async () => {
    const res = await post(memberA, memberA, { action: "self_exit", note: "巡演结束" });
    expect(res.status).toBe(200);
    const st = await getMemberStatus(prodId, memberA);
    expect(st?.status).toBe("suspended");
    expect(st?.statusSource).toBe("self");
  });

  it("退出后仍看得到自己的退出进度（闸门关了，isSelf 单独放行）", async () => {
    const res = await statusGet(
      req({ session: session(memberA), method: "GET" }),
      ctx({ id: prodId, userId: memberA }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status.status).toBe("suspended");
    expect(data.audit[0].action).toBe("self_exit");
  });
});

describe("处置门", () => {
  it("平级成员推不动出口——没有 member 删除门", async () => {
    const res = await post(memberB, memberA, { action: "restore" });
    expect(res.status).toBe(403);
    expect((await getMemberStatus(prodId, memberA))?.status).toBe("suspended");
  });

  it("owner 能复职", async () => {
    const res = await post(ownerId, memberA, { action: "restore" });
    expect(res.status).toBe(200);
    expect((await getMemberStatus(prodId, memberA))?.status).toBe("active");
  });

  it("不能对自己执行人事处置（owner 也不行）", async () => {
    const res = await post(ownerId, ownerId, { action: "suspend" });
    expect(res.status).toBe(403);
  });

  it("状态不对返回 409，不是 400/404", async () => {
    // memberA 此刻是 active，确认离组要求 suspended
    const res = await post(ownerId, memberA, { action: "confirm_exit" });
    expect(res.status).toBe(409);
  });

  it("不是成员返回 404", async () => {
    const res = await post(ownerId, outsider, { action: "suspend" });
    expect(res.status).toBe(404);
  });
});

describe("表态门", () => {
  it("不在处置链上的人不能表态", async () => {
    await post(memberA, memberA, { action: "self_exit" });
    const res = await post(memberB, memberA, { action: "object", note: "我不认可" });
    expect(res.status).toBe(403);
  });

  it("链上的人能表态，且不改状态", async () => {
    const res = await post(ownerId, memberA, { action: "endorse", note: "确实走了" });
    expect(res.status).toBe(200);
    expect((await getMemberStatus(prodId, memberA))?.status).toBe("suspended");
  });

  it("非 suspended 成员无从表态", async () => {
    await restoreMember(prodId, memberA, ownerId);
    const res = await post(ownerId, memberA, { action: "object" });
    expect(res.status).toBe(409);
  });
});

describe("归档项目", () => {
  it("已归档不可变更成员状态", async () => {
    await getPool().query("UPDATE production SET archived_at = NOW() WHERE id = $1", [prodId]);
    try {
      const res = await post(memberA, memberA, { action: "self_exit" });
      expect(res.status).toBe(403);
    } finally {
      await getPool().query("UPDATE production SET archived_at = NULL WHERE id = $1", [prodId]);
    }
  });
});
