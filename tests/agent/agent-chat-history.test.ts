import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/agent/chat/history/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { getPool } from "@/lib/pg";
import { attachTrustedAttachmentContext } from "@/lib/agent/agent-ui-context";
import { listAttachmentsForSession } from "@/lib/agent/attachment-db";
import { getHistoryPage, CHAT_HISTORY_PAGE_SIZE } from "@/lib/agent/runtime/chat-history-db";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

describe("聊天历史分页", () => {
  let userId: string, prodId: string;
  const keys: string[] = [];
  beforeAll(async () => {
    userId = (await upsertFeishuUser(`test-open-${shortId()}`, `历史分页${shortId()}`, null, false)).userId;
    ({ prodId } = await makeProduction(userId));
  });
  afterAll(async () => {
    for (const key of keys) await getPool().query("DELETE FROM agent_session WHERE id=$1", [key]);
    await cleanupProduction(prodId).catch(() => {});
  });
  async function makeSession() {
    const key = createNewSessionKey(userId, prodId);
    keys.push(key);
    const storage = await PgSessionStorage.create({ id: key, userId, productionId: prodId });
    return { key, storage, session: new Session(storage) };
  }
  async function append(session: Session, text: string) {
    return session.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  }

  it("只取最近一页正文；旧页固定快照，不重建模型上下文，也不受新消息挤动", async () => {
    const { key, session } = await makeSession();
    for (let i = 0; i < CHAT_HISTORY_PAGE_SIZE + 5; i++) await append(session, `记录-${i}`);
    const load = vi.spyOn(PgSessionStorage, "load");
    const build = vi.spyOn(Session.prototype, "buildContext");
    try {
      const latest = await getHistoryPage(key);
      expect(latest.messages).toHaveLength(CHAT_HISTORY_PAGE_SIZE);
      expect(latest.messages[0]).toMatchObject({ content: "记录-5" });
      expect(latest.nextCursor).not.toBeNull();
      await append(session, "快照之后的新消息");
      const older = await getHistoryPage(key, latest.nextCursor);
      expect(older.messages.map(message => "content" in message ? message.content : "")).toEqual([
        "记录-0", "记录-1", "记录-2", "记录-3", "记录-4",
      ]);
      expect(older.nextCursor).toBeNull();
      expect(new Set([...older.messages, ...latest.messages].map(message => message.key)).size).toBe(CHAT_HISTORY_PAGE_SIZE + 5);
      expect(load).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    } finally { load.mockRestore(); build.mockRestore(); }
  });

  it("压缩不删除可回看的历史；分支切换不泄露被放弃分支", async () => {
    const { key, session, storage } = await makeSession();
    const first = await append(session, "压缩前的讨论");
    const kept = await append(session, "保留尾段");
    await session.appendCompaction("模型摘要", kept, 1000);
    await append(session, "压缩后继续");
    expect((await getHistoryPage(key)).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "压缩前的讨论" }), expect.objectContaining({ content: "压缩后继续" }),
    ]));
    await storage.setLeafId(first);
    await append(session, "新的分支");
    const branch = await getHistoryPage(key);
    expect(branch.messages.map(message => "content" in message ? message.content : "")).toEqual(["压缩前的讨论", "新的分支"]);
  });

  it("side append 不污染可见分支，leaf 标记后的逻辑父关系沿用 vendor", async () => {
    const { key, session, storage } = await makeSession();
    await append(session, "正常消息");
    const parent = await storage.getLeafId();
    await storage.appendEntry({ type: "custom", id: "history-side-row", parentId: parent,
      timestamp: new Date().toISOString(), appendMode: "side", customType: "internal", data: { secret: "不应显示" } });
    await append(session, "侧记之后");
    expect((await getHistoryPage(key)).messages.map(message => "content" in message ? message.content : "")).toEqual(["正常消息", "侧记之后"]);
  });

  it("分页恢复跨页附件引用，不返回同会话无关附件或其他会话的附件", async () => {
    const { key, session } = await makeSession();
    const foreign = await makeSession();
    const original = `a_${shortId()}`, unused = `a_${shortId()}`, foreignId = `a_${shortId()}`;
    for (const [id, owner] of [[original, key], [unused, key], [foreignId, foreign.key]]) {
      await getPool().query(`INSERT INTO agent_session_attachment (id,session_id,r2_key,file_name,mime_type,file_size,status)
        VALUES ($1,$2,$3,'原件.png','image/png',100,'ready')`, [id, owner, `history-test/${id}`]);
    }
    const attachments = await listAttachmentsForSession(key);
    await append(session, attachTrustedAttachmentContext("请查看原件", attachments.filter(item => item.id === original)));
    for (let i = 0; i < CHAT_HISTORY_PAGE_SIZE; i++) await append(session, `中间记录-${i}`);
    // assistant 引用可指向上一页的附件；即使模型写了他人 id，也不能跨会话取元数据。
    await session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "核对原件" },
      { type: "text", text: `参考 [[attachment:${original}|舞台]] 和 [[attachment:${foreignId}|不可见]]，未完成片段 [[attachment:${unused}|稍后补齐` }],
      api: "openai-completions", provider: "deepseek", model: "fake", stopReason: "length", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const page = await getHistoryPage(key);
    expect(page.attachments.map(item => item.id)).toEqual([original]);
    expect(page.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "thinking", content: "核对原件" }),
      expect.objectContaining({ role: "notice", content: expect.stringContaining("尚未完成") }),
    ]));
    const earlier = await getHistoryPage(key, page.nextCursor);
    expect(earlier.messages[0]).toMatchObject({ role: "user", content: "请查看原件", attachments: [expect.objectContaining({ id: original })] });
  });

  it("历史路由拒绝未登录、他人会话与非法游标", async () => {
    const { key } = await makeSession();
    const url = `http://localhost/api/agent/chat/history?sessionKey=${encodeURIComponent(key)}`;
    expect((await GET(new NextRequest(url))).status).toBe(401);
    const foreignCookie = `${SESSION_COOKIE}=${createSession({ userId: "10310000-0000-4000-8000-000000000001", name: "他人", avatarUrl: null, isAdmin: false })}`;
    expect((await GET(new NextRequest(url, { headers: { Cookie: foreignCookie } }))).status).toBe(403);
    const ownCookie = `${SESSION_COOKIE}=${createSession({ userId, name: "本人", avatarUrl: null, isAdmin: false })}`;
    for (const cursor of ["broken", "1.-1", "1.0", "1.2", "2147483648.1", "9007199254740992.1"]) {
      expect((await GET(new NextRequest(`${url}&cursor=${encodeURIComponent(cursor)}`, { headers: { Cookie: ownCookie } }))).status).toBe(400);
    }
    const response = await GET(new NextRequest(url, { headers: { Cookie: ownCookie } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [], attachments: [], nextCursor: null });
  });
});
