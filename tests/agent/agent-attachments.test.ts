import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { cleanupProduction, makeProduction, setProductionTier, shortId } from "../_support/factories";
import { runAttachmentGcBatch } from "@/lib/agent/attachment-db";
import { renameSessionAttachment } from "@/lib/agent/tools/attachment-tools";
import { createPendingAttachment } from "@/lib/agent/attachment-db";
import { newRunId } from "@/lib/agent/runtime/ids";
import { RUNNER_OWNER } from "@/lib/agent/runtime/config";

const { presignMock, headMock, deleteMock, streamMock } = vi.hoisted(() => ({
  presignMock: vi.fn(),
  headMock: vi.fn(),
  deleteMock: vi.fn(),
  streamMock: vi.fn(),
}));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  presignedPut: presignMock,
  headR2Object: headMock,
  deleteR2Object: deleteMock,
  getR2Stream: streamMock,
}));

let userId: string;
let outsiderId: string;
let prodId: string;
let cookie: string;
let outsiderCookie: string;
const sessions: string[] = [];

function req(method: string, body?: unknown, authCookie = cookie): NextRequest {
  return new NextRequest("http://localhost/api/agent/attachments", {
    method,
    headers: { cookie: authCookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `attachment-owner-${shortId()}`, null, false));
  ({ userId: outsiderId } = await upsertFeishuUser(`test-open-${shortId()}`, `attachment-outsider-${shortId()}`, null, false));
  ({ prodId } = await makeProduction(userId));
  await setProductionTier(prodId, "pro");
  cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "主人", avatarUrl: null, isAdmin: false })}`;
  outsiderCookie = `${SESSION_COOKIE}=${createSession({ userId: outsiderId, name: "路人", avatarUrl: null, isAdmin: false })}`;
});

beforeEach(() => {
  presignMock.mockReset().mockReturnValue({ url: "https://r2.example/upload", contentType: "video/mp4" });
  headMock.mockReset().mockResolvedValue({ size: 12, contentType: "video/mp4" });
  deleteMock.mockReset().mockResolvedValue(undefined);
  streamMock.mockReset().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "image/png", "content-length": "3" },
  }));
});

afterAll(async () => {
  await getPool().query(`DELETE FROM agent_attachment_object WHERE session_id = ANY($1::text[])`, [sessions]).catch(() => {});
  for (const key of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [key]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("会话临时附件路由（#704）", () => {
  it("未登录 401；他人的 session key 与非成员项目会话均 403", async () => {
    const { GET, POST } = await import("@/app/api/agent/attachments/route");
    const personal = createNewSessionKey(userId);
    expect((await POST(new NextRequest("http://localhost/api/agent/attachments", { method: "POST" }))).status).toBe(401);
    expect((await GET(new NextRequest(`http://localhost/api/agent/attachments?sessionKey=${encodeURIComponent(personal)}`))).status).toBe(401);
    expect((await POST(req("POST", { sessionKey: personal, fileName: "x.txt", mimeType: "text/plain", fileSize: 1 }, outsiderCookie))).status).toBe(403);
    const productionKey = createNewSessionKey(outsiderId, prodId);
    expect((await POST(req("POST", { sessionKey: productionKey, fileName: "x.txt", mimeType: "text/plain", fileSize: 1 }, outsiderCookie))).status).toBe(403);
    const getAsOutsider = new NextRequest(`http://localhost/api/agent/attachments?sessionKey=${encodeURIComponent(productionKey)}`, {
      headers: { cookie: outsiderCookie },
    });
    expect((await GET(getAsOutsider)).status).toBe(403);
  });

  it("mediaKind 与 MIME 正交：Safari video/mp4 录音可登记为 audio，并在 HEAD 后 ready", async () => {
    const key = createNewSessionKey(userId);
    sessions.push(key);
    const { POST, PATCH } = await import("@/app/api/agent/attachments/route");
    const prepared = await POST(req("POST", {
      sessionKey: key,
      fileName: "录音.mp4",
      mimeType: "video/mp4",
      mediaKind: "audio",
      fileSize: 12,
    }));
    expect(prepared.status).toBe(201);
    const first = await prepared.json();
    expect(first.attachment).toMatchObject({ mediaKind: "audio", mimeType: "video/mp4", status: "pending" });
    const completed = await PATCH(req("PATCH", { sessionKey: key, attachmentId: first.attachment.id }));
    expect(completed.status).toBe(200);
    expect((await completed.json()).attachment).toMatchObject({ mediaKind: "audio", status: "ready" });
  });

  it("附件预览流逐次核对登录、会话归属与 ready 状态，不签发 R2 URL", async () => {
    const key = createNewSessionKey(userId);
    sessions.push(key);
    const { POST, PATCH } = await import("@/app/api/agent/attachments/route");
    const first = await (await POST(req("POST", { sessionKey: key, fileName: "generated.png", mimeType: "image/png", mediaKind: "image", fileSize: 3 }))).json();
    headMock.mockResolvedValueOnce({ size: 3, contentType: "image/png" });
    await PATCH(req("PATCH", { sessionKey: key, attachmentId: first.attachment.id }));
    await renameSessionAttachment({ userId, sessionId: key, attachmentId: first.attachment.id, fileName: "开场气氛图.png" });
    const { GET } = await import("@/app/api/agent/attachments/[id]/route");
    const ctx = { params: Promise.resolve({ id: first.attachment.id }) };
    expect((await GET(new NextRequest(`http://localhost/api/agent/attachments/${first.attachment.id}?sessionKey=${encodeURIComponent(key)}`), ctx)).status).toBe(401);
    expect((await GET(new NextRequest(`http://localhost/api/agent/attachments/${first.attachment.id}?sessionKey=${encodeURIComponent(key)}`, {
      headers: { cookie: outsiderCookie },
    }), ctx)).status).toBe(403);
    const response = await GET(new NextRequest(`http://localhost/api/agent/attachments/${first.attachment.id}?sessionKey=${encodeURIComponent(key)}`, {
      headers: { cookie },
    }), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("开场气氛图.png"));
    const download = await GET(new NextRequest(`http://localhost/api/agent/attachments/${first.attachment.id}?sessionKey=${encodeURIComponent(key)}&download=1`, { headers: { cookie } }), ctx);
    expect(download.headers.get("content-disposition")).toContain(`attachment; filename=`);
    expect(download.headers.get("content-disposition")).toContain(encodeURIComponent("开场气氛图.png"));
    const { GET: list } = await import("@/app/api/agent/attachments/route");
    const listed = await list(new NextRequest(`http://localhost/api/agent/attachments?sessionKey=${encodeURIComponent(key)}`, { headers: { cookie } }));
    expect((await listed.json()).attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.attachment.id, fileName: "开场气氛图.png" })]));
    expect(streamMock).toHaveBeenCalledWith(first.attachment.r2Key, null);
  });

  it("MMP 产物按 run/tool/output 原子占位并幂等复用，不借用 web_fetch URL 字段", async () => {
    const key = createNewSessionKey(userId);
    sessions.push(key);
    const runId = newRunId();
    await getPool().query("INSERT INTO agent_session(id,user_id) VALUES($1,$2)", [key, userId]);
    await getPool().query("INSERT INTO agent_run(id,session_id,status,owner,heartbeat_at) VALUES($1,$2,'running',$3,now())", [runId, key, RUNNER_OWNER]);
    const input = { sessionId: key, userId, fileName: "image.png", mimeType: "image/png", mediaKind: "image", fileSize: 1024,
      source: { kind: "mmp" as const, runId, toolCallId: "call-1", outputName: "image", outputIndex: 0,
        metadata: { capabilityId: "image.generate" } } };
    const first = await createPendingAttachment(input);
    const replay = await createPendingAttachment(input);
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({ sourceKind: "mmp", sourceRunId: runId, sourceToolCallId: "call-1",
      sourceOutputName: "image", sourceOutputIndex: 0, sourceUrl: null, sourceFinalUrl: null,
      sourceMetadata: { capabilityId: "image.generate" } });
  });

  it("上传完成后按 R2 HEAD 实际大小校准预占", async () => {
    const key = createNewSessionKey(userId);
    sessions.push(key);
    headMock.mockResolvedValueOnce({ size: 9, contentType: "text/plain" });
    const { POST, PATCH } = await import("@/app/api/agent/attachments/route");
    const prepared = await (await POST(req("POST", {
      sessionKey: key, fileName: "calibrate.txt", mimeType: "text/plain", fileSize: 12,
    }))).json();
    const completed = await PATCH(req("PATCH", { sessionKey: key, attachmentId: prepared.attachment.id }));
    expect(completed.status).toBe(200);
    expect((await completed.json()).attachment.fileSize).toBe(9);
  });

  it("删除附件同时清理 R2 原件", async () => {
    const key = createNewSessionKey(userId);
    sessions.push(key);
    const { POST, DELETE } = await import("@/app/api/agent/attachments/route");
    const first = await (await POST(req("POST", { sessionKey: key, fileName: "a.txt", mimeType: "text/plain", fileSize: 12 }))).json();
    const delReq = new NextRequest(`http://localhost/api/agent/attachments?sessionKey=${encodeURIComponent(key)}&attachmentId=${first.attachment.id}`, {
      method: "DELETE", headers: { cookie },
    });
    expect((await DELETE(delReq)).status).toBe(200);
    expect(deleteMock).not.toHaveBeenCalled();
    await runAttachmentGcBatch(1);
    expect(deleteMock).toHaveBeenCalledWith(first.attachment.r2Key);
  });

  it("R2 暂时删除失败时保留可重试对象状态", async () => {
    const key = createNewSessionKey(userId);
    sessions.push(key);
    const { POST, DELETE } = await import("@/app/api/agent/attachments/route");
    const first = await (await POST(req("POST", { sessionKey: key, fileName: "retry.txt", mimeType: "text/plain", fileSize: 12 }))).json();
    deleteMock.mockRejectedValueOnce(new Error("temporary R2 failure"));
    const response = await DELETE(new NextRequest(
      `http://localhost/api/agent/attachments?sessionKey=${encodeURIComponent(key)}&attachmentId=${first.attachment.id}`,
      { method: "DELETE", headers: { cookie } },
    ));
    expect(response.status).toBe(200);
    await runAttachmentGcBatch(1);
    const row = await getPool().query<{ status: string; attempts: number; last_error: string | null }>(
      `SELECT status, attempts, last_error FROM agent_attachment_object WHERE attachment_id = $1`, [first.attachment.id],
    );
    expect(row.rows[0]).toMatchObject({ status: "delete_pending", attempts: 1, last_error: "temporary R2 failure" });
  });

  it("附件不能跨会话绑定到消息", async () => {
    const sourceKey = createNewSessionKey(userId);
    const otherKey = createNewSessionKey(userId);
    sessions.push(sourceKey, otherKey);
    const { POST: prepare, PATCH } = await import("@/app/api/agent/attachments/route");
    const first = await (await prepare(req("POST", { sessionKey: sourceKey, fileName: "a.txt", mimeType: "text/plain", fileSize: 12 }))).json();
    await PATCH(req("PATCH", { sessionKey: sourceKey, attachmentId: first.attachment.id }));
    const { POST: chat } = await import("@/app/api/agent/chat/stream/route");
    const response = await chat(new NextRequest("http://localhost/api/agent/chat/stream", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: otherKey, message: "看看", attachmentIds: [first.attachment.id] }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "附件不存在、尚未上传完成或不属于该会话" });
  });
});
