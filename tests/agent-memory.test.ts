import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { faker } from "@faker-js/faker";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";

// 记忆后端所有权 PR 的三层测试：
//   1. store：追加/尾读/蒸馏增量消费的字节偏移语义
//   2. 上报与组装取件：appendRunRecord → buildInjectContext（MCP 端点已退役）
//   3. 蒸馏：mock LLM，验证输入组装（旧摘要+新增量）与落盘+offset 提交

// mock LLM（distill 经 @/lib/llm-chat 调用）。只替换 chat，保留真的
// LlmBudgetError——distill 用 instanceof 分流"预算不够"与其他失败，
// 换成假类会让分流逻辑在测试里恒假、测了个寂寞。
const chatMock = vi.fn(async (..._args: unknown[]) => "## 偏好与习惯\n- mock 蒸馏产物");
vi.mock("@/lib/llm-chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm-chat")>()),
  chat: (...args: unknown[]) => chatMock(...args),
}));

let userId: string;
let userName: string;
let prodId: string;

beforeAll(async () => {
  userName = `测试记忆${shortId()}`;
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, userName, null, false)).userId;
  ({ prodId } = await makeProduction(userId));
  await addProductionMember(prodId, userId);
  void faker;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  // 蒸馏/上报现在会同步写检索索引（agent_memory_chunk），清掉本测试用户的行
  const { getPool } = await import("@/lib/pg");
  await getPool().query("DELETE FROM agent_memory_chunk WHERE scope_id = $1", [userId]).catch(() => {});
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

describe("上报与组装取件（MCP 端点已退役，直接调 lib）", () => {
  it("appendRunRecord 落盘 → buildInjectContext 的 memory 含用户档案与近期对话", async () => {
    const { appendRunRecord } = await import("@/lib/agent-memory/store");
    const { buildInjectContext } = await import("@/lib/agent-memory/inject");
    appendRunRecord(userId, { ts: new Date().toISOString(), sessionKey: "agent:team:x", lastUser: "端点上报测试", lastAssistant: "收到" });
    const data = await buildInjectContext(userId);
    expect(data.memory).toBeTruthy();
    expect(data.memory!).toContain("## 当前用户");
    expect(data.memory!).toContain(userName);
    expect(data.memory!).toContain("端点上报测试"); // 近期对话段
  });

  it("带 prompt 的组装：命中触发词 → recall 字段；无关 prompt → recall 为 null", async () => {
    const { buildInjectContext } = await import("@/lib/agent-memory/inject");
    const { writeMemory } = await import("@/lib/agent-memory/store");
    const { indexCurated } = await import("@/lib/agent-memory/index-db");
    const md = "- 灯光 cue 表改动要先过舞监确认 <!-- trigger: 灯光cue --> <!-- importance: 8 -->";
    writeMemory(userId, md);
    await indexCurated("user", userId, md);
    try {
      const hit = await buildInjectContext(userId, undefined, "灯光cue表今天要改一版");
      expect(hit.memory).toContain("## 长期记忆摘要");
      expect(hit.memory).not.toContain("<!--"); // 注释剥离
      expect(hit.recall).toContain("灯光 cue 表改动要先过舞监确认");

      const miss = await buildInjectContext(userId, undefined, "今天天气如何");
      expect(miss.recall).toBeNull();
    } finally {
      const { getPool } = await import("@/lib/pg");
      await getPool().query("DELETE FROM agent_memory_chunk WHERE scope_id = $1", [userId]).catch(() => {});
    }
  });

  // 界面上下文的载荷随每条用户消息走，规则常驻这里（静态、可缓存）。规则
  // 若因"这个用户还没有任何记忆/档案"而整段不注入，就等于没有规则——所以
  // buildInjectContext 恒返回非 null（原先"什么都没有就返回 null"的早退已撤）。
  it("零记忆零档案的用户也拿得到界面上下文规则", async () => {
    const { buildInjectContext } = await import("@/lib/agent-memory/inject");
    const blank = "00000000-1111-2222-3333-444444444444";
    const data = await buildInjectContext(blank);
    expect(data.memory).toBeTruthy();
    expect(data.memory!).toContain("## 界面上下文说明");
    expect(data.memory!).toContain("clickin-ui-context");
    expect(data.memory!).not.toContain("## 长期记忆摘要"); // 确实没有别的段可注
  });

  it("MEMORY.md 内部二级标题注入时降级为三级（不与包裹标题同级）", async () => {
    const { buildInjectContext } = await import("@/lib/agent-memory/inject");
    const { writeMemory } = await import("@/lib/agent-memory/store");
    writeMemory(userId, "## 偏好与习惯\n- 喜欢先听结论\n# 顶级标题\n- x");
    const data = await buildInjectContext(userId);
    expect(data.memory).toContain("## 长期记忆摘要\n### 偏好与习惯");
    expect(data.memory).toContain("### 顶级标题");
    expect(data.memory).not.toMatch(/\n## 偏好与习惯/);
  });

  it("excludeSessionKey 过滤当前会话自身条目", async () => {
    const { buildInjectContext } = await import("@/lib/agent-memory/inject");
    const data = await buildInjectContext(userId, "agent:team:x");
    expect(data.memory ?? "").not.toContain("端点上报测试");
  });

  it("production 会话注入「当前制作」段（成员）", async () => {
    const { buildInjectContext } = await import("@/lib/agent-memory/inject");
    const sessionKey = `agent:team:clickin:chat:${userId}:${prodId}:11111111-2222-3333-4444-555555555555`;
    const data = await buildInjectContext(userId, sessionKey);
    expect(data.memory).toContain("## 当前制作");
    expect(data.memory).toContain("我的角色");
  });

  it("非成员的 production 会话不注入制作段（实时资格校验）", async () => {
    const { buildInjectContext } = await import("@/lib/agent-memory/inject");
    const { makeProduction: mk } = await import("./factories");
    const { prodId: otherProd } = await mk(); // 无 owner、无成员
    try {
      const sessionKey = `clickin:chat:${userId}:${otherProd}:11111111-2222-3333-4444-555555555555`;
      const data = await buildInjectContext(userId, sessionKey);
      expect(data.memory ?? "").not.toContain("## 当前制作");
    } finally {
      const { cleanupProduction: cp } = await import("./factories");
      await cp(otherProd).catch(() => {});
    }
  });
});

describe("蒸馏管线（mock LLM）", () => {
  it("消费增量 → LLM 输入含旧摘要与新对话 → 写 MEMORY.md + 提交 offset", async () => {
    const { writeMemory, readMemory } = await import("@/lib/agent-memory/store");
    const { distillUser } = await import("@/lib/agent-memory/distill");
    writeMemory(userId, "- 旧记忆条目：喜欢先听结论");

    const result = await distillUser(userId);
    expect(result.status).toBe("distilled");
    expect(result.shrunk).toBe(false);  // 首档就成功，没降过

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

  // 2026-08-17 线上：推理模型把 max_tokens 当 CoT+正文总预算，蒸馏每次都撞
  // finish_reason=length。若只在输出侧加预算（有模型上限），注定超预算的那批
  // 会天天以同样方式失败、offset 永不推进 —— 该用户记忆永久停更。所以撞预算
  // 时要缩**输入**。
  it("预算不够 → 降档缩小输入重试，成功后照常提交 offset", async () => {
    const { appendRunRecord } = await import("@/lib/agent-memory/store");
    const { distillUser } = await import("@/lib/agent-memory/distill");
    const { LlmBudgetError } = await import("@/lib/llm-chat");
    appendRunRecord(userId, { ts: new Date().toISOString(), lastUser: "降档批", lastAssistant: "y" });

    // 首档（24000）超预算，降到 12000 成功
    chatMock.mockRejectedValueOnce(new LlmBudgetError("empty (finish_reason=length)", false));
    const result = await distillUser(userId);
    expect(result.status).toBe("distilled");
    expect(result.inputChars).toBe(12_000);
    // shrunk 由 distill 模块判定（档位表在那边），路由只数这个布尔
    expect(result.shrunk).toBe(true);
    expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // offset 已推进：同批数据不会被再吃一次
    const again = await distillUser(userId);
    expect(again.status).toBe("no-new-data");
  });

  it("每档都超预算 → 跳过该条并推进 offset，不把后续蒸馏永久堵死", async () => {
    const { appendRunRecord } = await import("@/lib/agent-memory/store");
    const { distillUser } = await import("@/lib/agent-memory/distill");
    const { LlmBudgetError } = await import("@/lib/llm-chat");
    appendRunRecord(userId, { ts: new Date().toISOString(), lastUser: "毒丸批", lastAssistant: "z" });

    chatMock.mockRejectedValue(new LlmBudgetError("empty (finish_reason=length)", false));
    const stuck = await distillUser(userId);
    expect(stuck.status).toBe("skipped");
    expect(stuck.error).toMatch(/finish_reason=length/);

    // 关键：偏移推进了，下一轮不会再撞同一条
    chatMock.mockReset();
    chatMock.mockResolvedValue("## 偏好与习惯\n- mock 蒸馏产物");
    const next = await distillUser(userId);
    expect(next.status).toBe("no-new-data");
  });

  it("非预算失败不缩输入、不跳过：只打一次且不提交 offset", async () => {
    const { appendRunRecord } = await import("@/lib/agent-memory/store");
    const { distillUser } = await import("@/lib/agent-memory/distill");
    appendRunRecord(userId, { ts: new Date().toISOString(), lastUser: "网络抖动批", lastAssistant: "w" });

    chatMock.mockReset();
    chatMock.mockRejectedValue(new Error("provider down"));
    const failed = await distillUser(userId);
    expect(failed.status).toBe("error");
    expect(chatMock.mock.calls).toHaveLength(1);  // 不该逐档重试

    chatMock.mockReset();
    chatMock.mockResolvedValue("## 偏好与习惯\n- mock 蒸馏产物");
    const retried = await distillUser(userId);
    expect(retried.status).toBe("distilled");  // 同批数据未丢
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
