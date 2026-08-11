import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { faker } from "@faker-js/faker";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";

// 记忆后端所有权 PR 的三层测试：
//   1. store：追加/尾读/蒸馏增量消费的字节偏移语义
//   2. MCP 端点：POST /memory-run 上报 → GET /inject-context 组装取件
//   3. 蒸馏：mock LLM，验证输入组装（旧摘要+新增量）与落盘+offset 提交

// mock LLM（distill 经 @/agent/llm 调用）
const chatMock = vi.fn(async (..._args: unknown[]) => "## 偏好与习惯\n- mock 蒸馏产物");
vi.mock("@/agent/llm", () => ({ chat: (...args: unknown[]) => chatMock(...args) }));

process.env.MCP_PORT = "3196";
const BASE = "http://127.0.0.1:3196";

type FakeStore = {
  client: unknown;
  status: { state: string };
  connecting: null;
  events: EventEmitter;
  pendingApprovals: Map<string, unknown>;
  denyReasons: Map<string, unknown>;
  pendingSteers: Map<string, number[]>;
};
const g = globalThis as unknown as {
  __mcpHttpServer?: { close: (cb?: () => void) => void };
  __clickinAgentGateway?: FakeStore;
};

let userId: string;
let userName: string;
let prodId: string;

beforeAll(async () => {
  g.__clickinAgentGateway = {
    client: null,
    status: { state: "connected" },
    connecting: null,
    events: new EventEmitter(),
    pendingApprovals: new Map(),
    denyReasons: new Map(),
    pendingSteers: new Map(),
  };
  userName = `测试记忆${shortId()}`;
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, userName, null, false)).userId;
  ({ prodId } = await makeProduction(userId));
  await addProductionMember(prodId, userId);

  const { startMcpServer } = await import("@/lib/mcp/server");
  startMcpServer();
  await new Promise((r) => setTimeout(r, 150));
  void faker;
});

afterAll(async () => {
  const server = g.__mcpHttpServer;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  delete g.__mcpHttpServer;
  await cleanupProduction(prodId).catch(() => {});
});

describe("store：字节偏移增量语义", () => {
  it("append → readRunsSinceLastDistill → commit → 再读为空", async () => {
    const { appendRunRecord, readRunsSinceLastDistill, commitDistill } = await import("@/lib/agent-memory/store");
    appendRunRecord(userId, { ts: new Date().toISOString(), lastUser: "第一条", lastAssistant: "回复一" });
    appendRunRecord(userId, { ts: new Date().toISOString(), lastUser: "第二条", lastAssistant: "回复二" });

    const first = readRunsSinceLastDistill(userId, 100_000);
    expect(first.entries).toHaveLength(2);
    commitDistill(userId, first.nextOffset);

    const second = readRunsSinceLastDistill(userId, 100_000);
    expect(second.entries).toHaveLength(0);

    appendRunRecord(userId, { ts: new Date().toISOString(), lastUser: "第三条", lastAssistant: "回复三" });
    const third = readRunsSinceLastDistill(userId, 100_000);
    expect(third.entries).toHaveLength(1);
    expect(third.entries[0].lastUser).toBe("第三条");
  });

  it("非法 userId 拒绝进入路径拼接", async () => {
    const { appendRunRecord } = await import("@/lib/agent-memory/store");
    expect(() => appendRunRecord("../evil", { ts: new Date().toISOString() })).toThrow();
  });

  it("截断批次：nextOffset 停在最后已消费行，剩余数据下次继续（#205 critical 回归）", async () => {
    const { appendRunRecord, readRunsSinceLastDistill, commitDistill } = await import("@/lib/agent-memory/store");
    // 独立用户目录，避免与其他用例的 offset 状态耦合
    const uid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01";
    appendRunRecord(uid, { ts: new Date().toISOString(), lastUser: "批次甲".repeat(20), lastAssistant: "x" });
    appendRunRecord(uid, { ts: new Date().toISOString(), lastUser: "批次乙".repeat(20), lastAssistant: "x" });
    appendRunRecord(uid, { ts: new Date().toISOString(), lastUser: "批次丙".repeat(20), lastAssistant: "x" });

    // maxChars 只够装下第一条 → 截断
    const first = readRunsSinceLastDistill(uid, 10);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].lastUser).toContain("批次甲");
    commitDistill(uid, first.nextOffset);

    // 旧 bug：这里会拿到空（offset 已跳到文件尾，乙/丙永久丢失）
    const second = readRunsSinceLastDistill(uid, 10);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].lastUser).toContain("批次乙");
    commitDistill(uid, second.nextOffset);

    const third = readRunsSinceLastDistill(uid, 100_000);
    expect(third.entries).toHaveLength(1);
    expect(third.entries[0].lastUser).toContain("批次丙");
    commitDistill(uid, third.nextOffset);

    expect(readRunsSinceLastDistill(uid, 100_000).entries).toHaveLength(0);
  });
});

describe("MCP 端点：上报与组装取件", () => {
  it("POST /memory-run 落盘，GET /inject-context 含用户档案与近期对话", async () => {
    const res = await fetch(`${BASE}/memory-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        record: { ts: new Date().toISOString(), sessionKey: "agent:team:x", lastUser: "端点上报测试", lastAssistant: "收到" },
      }),
    });
    expect(res.status).toBe(200);

    const inject = await fetch(`${BASE}/inject-context?userId=${userId}`);
    const data = (await inject.json()) as { markdown: string | null };
    expect(data.markdown).toBeTruthy();
    expect(data.markdown!).toContain("## 当前用户");
    expect(data.markdown!).toContain(userName);
    expect(data.markdown!).toContain("端点上报测试"); // 近期对话段
  });

  it("MEMORY.md 内部二级标题注入时降级为三级（不与包裹标题同级）", async () => {
    const { writeMemory } = await import("@/lib/agent-memory/store");
    writeMemory(userId, "## 偏好与习惯\n- 喜欢先听结论\n# 顶级标题\n- x");
    const inject = await fetch(`${BASE}/inject-context?userId=${userId}`);
    const data = (await inject.json()) as { markdown: string };
    expect(data.markdown).toContain("## 长期记忆摘要\n### 偏好与习惯");
    expect(data.markdown).toContain("### 顶级标题");
    expect(data.markdown).not.toMatch(/\n## 偏好与习惯/);
  });

  it("excludeSessionKey 过滤当前会话自身条目", async () => {
    const inject = await fetch(`${BASE}/inject-context?userId=${userId}&sessionKey=agent:team:x`);
    const data = (await inject.json()) as { markdown: string | null };
    expect(data.markdown ?? "").not.toContain("端点上报测试");
  });

  it("缺 userId → 400；非法 record → 400", async () => {
    expect((await fetch(`${BASE}/inject-context`)).status).toBe(400);
    const bad = await fetch(`${BASE}/memory-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("蒸馏管线（mock LLM）", () => {
  it("消费增量 → LLM 输入含旧摘要与新对话 → 写 MEMORY.md + 提交 offset", async () => {
    const { writeMemory, readMemory } = await import("@/lib/agent-memory/store");
    const { distillUser } = await import("@/lib/agent-memory/distill");
    writeMemory(userId, "- 旧记忆条目：喜欢先听结论");

    const result = await distillUser(userId);
    expect(result.status).toBe("distilled");

    // LLM 输入组装验证
    const callArgs = chatMock.mock.calls.at(-1)! as unknown[];
    const messages = callArgs[0] as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("旧记忆条目：喜欢先听结论");
    expect(userMsg).toContain("端点上报测试");

    // 落盘 + offset 提交
    expect(readMemory(userId, 4000)).toContain("mock 蒸馏产物");
    const again = await distillUser(userId);
    expect(again.status).toBe("no-new-data");
  });

  it("LLM 失败 → error 状态且不提交 offset（下次重试同批数据）", async () => {
    const { appendRunRecord } = await import("@/lib/agent-memory/store");
    const { distillUser } = await import("@/lib/agent-memory/distill");
    appendRunRecord(userId, { ts: new Date().toISOString(), lastUser: "失败重试批", lastAssistant: "x" });

    chatMock.mockRejectedValueOnce(new Error("provider down"));
    const failed = await distillUser(userId);
    expect(failed.status).toBe("error");

    const retried = await distillUser(userId); // mock 恢复默认成功
    expect(retried.status).toBe("distilled"); // 同批数据未丢
  });
});
