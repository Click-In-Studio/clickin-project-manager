import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { cleanupProduction, makeProduction, setProductionTier, shortId } from "../_support/factories";

const { presignMock, headMock, deleteMock } = vi.hoisted(() => ({
  presignMock: vi.fn(),
  headMock: vi.fn(),
  deleteMock: vi.fn(),
}));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  presignedPut: presignMock,
  headR2Object: headMock,
  deleteR2Object: deleteMock,
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
});

afterAll(async () => {
  for (const key of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [key]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("会话临时附件路由（#704）", () => {
  it("未登录 401；他人的 session key 与非成员项目会话均 403", async () => {
    const { POST } = await import("@/app/api/agent/attachments/route");
    const personal = createNewSessionKey(userId);
    expect((await POST(new NextRequest("http://localhost/api/agent/attachments", { method: "POST" }))).status).toBe(401);
    expect((await POST(req("POST", { sessionKey: personal, fileName: "x.txt", mimeType: "text/plain", fileSize: 1 }, outsiderCookie))).status).toBe(403);
    const productionKey = createNewSessionKey(outsiderId, prodId);
    expect((await POST(req("POST", { sessionKey: productionKey, fileName: "x.txt", mimeType: "text/plain", fileSize: 1 }, outsiderCookie))).status).toBe(403);
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

  it("删除附件同时清理 R2 原件", async () => {
    const key = createNewSessionKey(userId);
    sessions.push(key);
    const { POST, DELETE } = await import("@/app/api/agent/attachments/route");
    const first = await (await POST(req("POST", { sessionKey: key, fileName: "a.txt", mimeType: "text/plain", fileSize: 12 }))).json();
    const delReq = new NextRequest(`http://localhost/api/agent/attachments?sessionKey=${encodeURIComponent(key)}&attachmentId=${first.attachment.id}`, {
      method: "DELETE", headers: { cookie },
    });
    expect((await DELETE(delReq)).status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith(first.attachment.r2Key);
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
