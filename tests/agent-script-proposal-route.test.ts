import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { GET } from "@/app/api/agent/script-proposal/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { makeProduction, cleanupProduction, makeScene, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, applyPatchToDB } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { createNewSessionKey } from "@/lib/agent-tools/session-identity";
import { PgSessionStorage } from "@/lib/agent-runtime/pg-session-storage";
import type { Block } from "@/lib/script-types";

// /api/agent/script-proposal：确认卡「查看详情」的剧本写提议预览通道。
// 核心保证：①所有权 = 审批行归属会话的主人（requireOwnership），别人拿着
// toolCallId 也看不到；②制作维度与会话身份对表；③预览与 preflight/执行是
// 同一份 previewScriptProposal（逐块 diff 概要现算）。

let prodId: string;
let ownerId: string;
let writerId: string;
let chId: string;
let d1: string;
let toolCallId: string;

function makeReq(userId: string | null, pid: string, callId: string): NextRequest {
  const cookie = userId
    ? `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`
    : "";
  const url = `http://localhost/api/agent/script-proposal?productionId=${pid}&toolCallId=${encodeURIComponent(callId)}`;
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : {} });
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `路由所有者${shortId()}`, null, false)).userId;
  writerId = (await upsertFeishuUser(`test-open-${shortId()}`, `路由编剧${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, writerId);
  for (const verb of ["view", "edit"]) {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'script', '*', 'blocks', $3, 'direct', $2)`,
      [prodId, writerId, verb]);
  }
  const versionId = (await getPool().query<{ active_version_id: string }>(
    `SELECT active_version_id FROM production WHERE id = $1`, [prodId])).rows[0].active_version_id;
  chId = await makeScene(prodId, versionId, { number: "1", name: "第一章" });
  d1 = randomUUID();
  const block: Block = {
    id: d1, type: "dialogue", content: "原台词",
    characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null,
  };
  await applyPatchToDB(prodId, versionId, { clientSeq: 1, blockOps: [{ op: "insert", block, afterId: chId }], charOps: [], sceneOps: [] });

  // 造审批行（挂在 writer 的 production 会话上）
  const key = createNewSessionKey(writerId, prodId);
  await PgSessionStorage.create({ id: key, userId: writerId, productionId: prodId });
  const runId = `ar_sp_${shortId()}`;
  await getPool().query(`INSERT INTO agent_run (id, session_id, status) VALUES ($1, $2, 'running')`, [runId, key]);
  toolCallId = `call_${shortId()}`;
  const dialect = `[m:${chId}] #\n[b:${d1}] [白] 改后的台词`;
  await getPool().query(
    `INSERT INTO agent_approval (id, run_id, session_id, tool_call_id, tool, args, preview, expires_at)
     VALUES ($1, $2, $3, $4, 'clickin__production-script_propose_rewrite', $5::jsonb, '{}'::jsonb, now() + interval '10 minutes')`,
    [`ap_${shortId()}`, runId, key, toolCallId, JSON.stringify({ sectionId: chId, dialect, summary: "测试改写" })],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("GET /api/agent/script-proposal", () => {
  it("未登录 401；缺参数 400；未知 toolCallId 404", async () => {
    expect((await GET(makeReq(null, prodId, toolCallId))).status).toBe(401);
    const noParam = new NextRequest("http://localhost/api/agent/script-proposal", {
      headers: { Cookie: `${SESSION_COOKIE}=${createSession({ userId: writerId, name: "x", avatarUrl: null, isAdmin: false })}` },
    });
    expect((await GET(noParam)).status).toBe(400);
    expect((await GET(makeReq(writerId, prodId, `call_${shortId()}`))).status).toBe(404);
  });

  it("非会话主人 403（不泄露存在性差异之外的信息）；制作维度不匹配 404", async () => {
    expect((await GET(makeReq(ownerId, prodId, toolCallId))).status).toBe(403);
    expect((await GET(makeReq(writerId, `p${shortId()}`, toolCallId))).status).toBe(404);
  });

  it("会话主人取到现算预览：kind/summary/dialect 原样、notes 含逐块 diff 概要", async () => {
    const res = await GET(makeReq(writerId, prodId, toolCallId));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { kind: string; summary: string; dialect: string | null; hasPermission: boolean; notes: string[]; error: string | null };
    expect(data.kind).toBe("rewrite");
    expect(data.summary).toBe("测试改写");
    expect(data.dialect).toContain(`[b:${d1}]`);
    expect(data.error).toBeNull();
    expect(data.hasPermission).toBe(true);
    expect(data.notes.join("\n")).toContain("修改 1 块");
  });
});
