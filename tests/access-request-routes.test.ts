/**
 * 资源申请路由层测试（route handler 直调，不起 HTTP server）。
 *
 * 与 approval-flow.test.ts 的分工：那边测 lib 层的状态机与链语义，这边只测
 * **路由自己的那几行**——鉴权门、入参校验、请求体解析。这些分支在 lib 测试里
 * 一条也走不到。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { addProductionMember, submitAccessRequest } from "@/lib/db";
import { MAX_APPROVAL_COMMENT_LENGTH } from "@/lib/approval-stages";
import { getPool } from "@/lib/pg";
import { TEST_USER } from "./helpers";
import { makeProduction, cleanupProduction } from "./factories";

import { GET as previewHandler } from "@/app/api/production/[id]/access-requests/preview/route";
import { POST as approveHandler } from "@/app/api/production/[id]/access-requests/[reqId]/approve/route";
import { POST as rejectHandler } from "@/app/api/production/[id]/access-requests/[reqId]/reject/route";
import { POST as escalateHandler } from "@/app/api/production/[id]/access-requests/[reqId]/escalate/route";
import { POST as cancelHandler } from "@/app/api/production/[id]/access-requests/[reqId]/cancel/route";

const U_OWNER    = "00000000-0000-0000-0002-000000000001";
const U_OUTSIDER = "00000000-0000-0000-0002-000000000002";

let prodId: string;

function session(userId: string) {
  return createSession({ userId, name: "路由测试用户", avatarUrl: null, isAdmin: false });
}

function req(url: string, opts: { session?: string; method?: string; body?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    body: opts.body,
    headers,
  });
}

// 路由 handler 的 params 形状各异，any 避免结构性不匹配的假报错
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

beforeAll(async () => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_user (id) SELECT * FROM UNNEST($1::uuid[]) ON CONFLICT DO NOTHING`,
    [[U_OWNER, U_OUTSIDER]],
  );
  await pool.query(
    `INSERT INTO user_profile (user_id, name)
     SELECT * FROM UNNEST($1::uuid[], $2::text[])
     ON CONFLICT (user_id) DO NOTHING`,
    [[U_OWNER, U_OUTSIDER], ["路由Owner", "非成员"]],
  );

  ({ prodId } = await makeProduction(U_OWNER));
  await addProductionMember(prodId, TEST_USER);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool()
    .query(`DELETE FROM app_user WHERE id = ANY($1)`, [[U_OWNER, U_OUTSIDER]])
    .catch(() => {});
});

// ─── preview ──────────────────────────────────────────────────────────────────

describe("GET /api/production/[id]/access-requests/preview", () => {
  const query = "?resourceType=cue_list&permissionLevel=view";

  it("未登录 → 401", async () => {
    const res = await previewHandler(req(`/x${query}`), ctx({ id: prodId }));
    expect(res.status).toBe(401);
  });

  it("非本演出成员 → 403", async () => {
    const res = await previewHandler(
      req(`/x${query}`, { session: session(U_OUTSIDER) }),
      ctx({ id: prodId }),
    );
    expect(res.status).toBe(403);
  });

  it("缺 resourceType / permissionLevel → 400", async () => {
    for (const q of ["", "?resourceType=cue_list", "?permissionLevel=view"]) {
      const res = await previewHandler(
        req(`/x${q}`, { session: session(TEST_USER) }),
        ctx({ id: prodId }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("成员 → 200，带治理域、阶梯与人员", async () => {
    const res = await previewHandler(
      req(`/x${query}`, { session: session(TEST_USER) }),
      ctx({ id: prodId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodeClass).toBe("normal");
    expect(body.stages.length).toBeGreaterThan(0);
    // owner 兜底级恒在，且带得出姓名
    expect(body.people[U_OWNER]?.name).toBe("路由Owner");
  });

  it("ROOT 权限：预览就说清楚没有审批通道，不必等提交后吃 403", async () => {
    const res = await previewHandler(
      req("/x?resourceType=production&resourceSub=*&permissionLevel=delete", {
        session: session(TEST_USER),
      }),
      ctx({ id: prodId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodeClass).toBe("root");
    expect(body.stages).toEqual([]);
  });

  // 安全属性：阶梯本身是一张组织关系图（谁向谁汇报、哪个部门谁负责）。
  // subjectId 只能取 session——哪天有人"顺手"加个 ?subjectId= 入参，这条会红。
  it("subjectId 不可被 query 覆盖：查的恒是自己的链", async () => {
    const mine = await previewHandler(
      req(`/x${query}`, { session: session(TEST_USER) }),
      ctx({ id: prodId }),
    );
    const spoofed = await previewHandler(
      req(`/x${query}&subjectId=${U_OWNER}`, { session: session(TEST_USER) }),
      ctx({ id: prodId }),
    );
    expect(await spoofed.json()).toEqual(await mine.json());
  });
});

// ─── 动作路由的请求体解析 ──────────────────────────────────────────────────────

describe("动作路由 — 请求体解析", () => {
  const handlers = [
    { name: "approve",  fn: approveHandler },
    { name: "reject",   fn: rejectHandler },
    { name: "escalate", fn: escalateHandler },
    { name: "cancel",   fn: cancelHandler },
  ] as const;

  // 回归：`.catch(() => ({}))` 只兜得住**解析失败**。合法的 JSON `null` 会解析
  // 成功并返回 null，`const { comment } = null` 直接 TypeError → 500。
  // 四个路由当时是同一个写法，所以是同一个洞。
  it.each(handlers)("$name：body 为 JSON null 不炸（500 而非优雅路径）", async ({ fn }) => {
    const res = await fn(
      req("/x", { session: session(TEST_USER), method: "POST", body: "null" }),
      ctx({ id: prodId, reqId: "00000000-0000-0000-0000-0000000000aa" }),
    );
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);  // 走到 lib 层，报「申请不存在」
  });

  it.each(handlers)("$name：完全不发 body 也不炸", async ({ fn }) => {
    const res = await fn(
      req("/x", { session: session(TEST_USER), method: "POST" }),
      ctx({ id: prodId, reqId: "00000000-0000-0000-0000-0000000000aa" }),
    );
    expect(res.status).toBe(404);
  });

  it.each(handlers)("$name：body 为非对象 JSON 也不炸", async ({ fn }) => {
    for (const body of ['"just a string"', "42", "[1,2,3]"]) {
      const res = await fn(
        req("/x", { session: session(TEST_USER), method: "POST", body }),
        ctx({ id: prodId, reqId: "00000000-0000-0000-0000-0000000000aa" }),
      );
      expect(res.status).toBe(404);
    }
  });

  it("超长意见 → 400，且检查发生在动手之前", async () => {
    const request = await submitAccessRequest(prodId, TEST_USER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const res = await cancelHandler(
      req("/x", {
        session: session(TEST_USER),
        method: "POST",
        body: JSON.stringify({ comment: "字".repeat(MAX_APPROVAL_COMMENT_LENGTH + 1) }),
      }),
      ctx({ id: prodId, reqId: request.id }),
    );
    expect(res.status).toBe(400);

    const row = await getPool().query<{ status: string }>(
      `SELECT status FROM approval_request WHERE id = $1`, [request.id]);
    expect(row.rows[0].status).toBe("pending_resource");
  });

  it("撤回带说明 → 200，回带终态申请", async () => {
    const request = await submitAccessRequest(prodId, TEST_USER, {
      resourceType: "cue_list", permissionLevel: "edit",
    });
    const res = await cancelHandler(
      req("/x", {
        session: session(TEST_USER),
        method: "POST",
        body: JSON.stringify({ comment: "先不申请了" }),
      }),
      ctx({ id: prodId, reqId: request.id }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.status).toBe("cancelled");
    expect(body.request.resolvedBy).toBe(TEST_USER);
  });

  it("未登录 → 401（四个动作路由一致）", async () => {
    for (const { fn } of handlers) {
      const res = await fn(
        req("/x", { method: "POST" }),
        ctx({ id: prodId, reqId: "00000000-0000-0000-0000-0000000000aa" }),
      );
      expect(res.status).toBe(401);
    }
  });

  it("非本演出成员 → 403（四个动作路由一致）", async () => {
    for (const { fn } of handlers) {
      const res = await fn(
        req("/x", { session: session(U_OUTSIDER), method: "POST" }),
        ctx({ id: prodId, reqId: "00000000-0000-0000-0000-0000000000aa" }),
      );
      expect(res.status).toBe(403);
    }
  });
});
