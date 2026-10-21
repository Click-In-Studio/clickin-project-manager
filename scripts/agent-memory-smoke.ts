// #1034 小规模真实模型 smoke：只用独立本地测试库与合成资料，不是可靠性 benchmark。
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import type {
  Message,
  ToolCall,
} from "../vendor/openclaw/packages/llm-core/src/types";

async function main() {
  if (!process.env.PGDATABASE?.startsWith("clickin_memory_1034_test_"))
    throw new Error("只允许显式选择本轮独立测试库");
  process.env.EMBEDDING_PROVIDER = "none";
  const { getPool } = await import("../lib/pg");
  const { upsertFeishuUser } = await import("../lib/account/db-feishu");
  const { makeProduction, cleanupProduction, shortId } = await import(
    "../tests/_support/factories"
  );
  const { PgSessionStorage } = await import(
    "../lib/agent/runtime/pg-session-storage"
  );
  const { createNewSessionKey } = await import(
    "../lib/agent/tools/session-identity"
  );
  const { buildTools } = await import("../lib/agent/runtime/tools");
  const { resolveModel, modelApiKey, llmRuntime } = await import(
    "../lib/agent/runtime/config"
  );
  const { buildInjectContext } = await import("../lib/agent/memory/inject");
  const { readMemoryScope, mutateMemoryEntry } = await import(
    "../lib/agent/memory/memory-db"
  );
  const { readMemoryGroups } = await import(
    "../lib/agent/memory/memory-group-db"
  );
  const { organizeMemoryScope } = await import("../lib/agent/memory/organize");
  const model = resolveModel(
    process.env.MEMORY_SMOKE_MODEL ?? "deepseek-flash",
  );
  const uid = (
    await upsertFeishuUser(
      `memory-smoke-${shortId()}`,
      "记忆冒烟合成用户",
      null,
      false,
    )
  ).userId;
  const { prodId } = await makeProduction(uid);
  const reports: Array<Record<string, unknown>> = [];
  async function turn(message: string) {
    const sessionId = createNewSessionKey(uid, prodId);
    await PgSessionStorage.create({
      id: sessionId,
      userId: uid,
      productionId: prodId,
    });
    const runId = `memory_smoke_${shortId()}`;
    await getPool().query(
      "INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')",
      [runId, sessionId],
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    const calls: string[] = [];
    const messages: Message[] = [
      { role: "user", content: message, timestamp: Date.now() },
    ];
    let final = "";
    let tokens = 0;
    try {
      const run = {
        runId,
        sessionId,
        signal: controller.signal,
        publish: () => {},
        setStatus: async () => {},
        isDetached: () => false,
      };
      const tools = buildTools({
        userId: uid,
        productionId: prodId,
        run,
      }).filter((t) => t.mcpName.startsWith("my.memory_"));
      for (let i = 0; i < 10; i++) {
        const inject = await buildInjectContext(uid, sessionId, message);
        const response = await llmRuntime().completeSimple(
          model,
          {
            systemPrompt: `你是戏剧项目助理。用简体中文直接协作，回答简短。\n当前项目id:${prodId}\n${inject.memory}`,
            messages,
            tools: tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          },
          {
            apiKey: modelApiKey(model),
            signal: controller.signal,
            maxTokens: 5000,
            temperature: 0,
            reasoning: "off",
          },
        );
        if (
          response.stopReason === "error" ||
          response.stopReason === "aborted" ||
          response.stopReason === "length"
        )
          throw new Error(`模型未完成:${response.stopReason}`);
        messages.push(response);
        tokens += response.usage.input + response.usage.output;
        const pending = response.content.filter(
          (p): p is ToolCall => p.type === "toolCall",
        );
        if (!pending.length) {
          final = response.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
          break;
        }
        for (const call of pending) {
          const tool = tools.find((t) => t.name === call.name);
          if (!tool) throw new Error("调用了smoke范围外工具");
          calls.push(tool.mcpName);
          try {
            const result = await tool.execute(
              call.id,
              call.arguments,
              controller.signal,
            );
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: result.content,
              isError: false,
              timestamp: Date.now(),
            });
          } catch (error) {
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : "工具失败",
                },
              ],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }
      }
      if (!final) throw new Error("达到10次模型请求上限仍未完成");
      return { calls, final, tokens };
    } finally {
      clearTimeout(timeout);
      await getPool().query(
        "UPDATE agent_run SET status='completed' WHERE id=$1",
        [runId],
      );
    }
  }
  try {
    const first = await turn(
      "这个项目围绕诗经展开，文献放在文档库的“诗经研究”文件夹，后续声音设计需要参考。今天先到这里，简短回复即可。",
    );
    let memory = await readMemoryScope(uid, prodId);
    const remembered = memory.entries.some((e) => e.body.includes("诗经研究"));
    reports.push({ case: "自然交代后主动记录", ...first, remembered });
    if (!remembered) throw new Error("自然交代后没有保存资料入口");
    const reused = await turn(
      "我要把之前的研究资料入口告诉声音设计师，告诉他去哪看就好，不需要展开文献内容。",
    );
    reports.push({ case: "跨会话使用brief直接touch", ...reused });
    if (!reused.calls.includes("my.memory_touch"))
      throw new Error("使用brief时没有touch");
    const a = await mutateMemoryEntry(uid, prodId, {
      action: "create",
      actor: "agent",
      body: "本项目所有音响、音乐cue以《音响cue表》为准。",
      brief: "音响音乐cue以《音响cue表》为准",
    });
    const b = await mutateMemoryEntry(uid, prodId, {
      action: "create",
      actor: "agent",
      body: "本项目所有音响、音乐cue以《音响cue表v2》为准。",
      brief: "音响音乐cue以《音响cue表v2》为准",
    });
    const organized = await organizeMemoryScope(uid, prodId);
    const candidates = await readMemoryGroups(uid, prodId, [a, b]);
    const cueGroup = candidates.find((g) =>
      g.entries.some((e) => e.id === a),
    );
    reports.push({
      case: "真实整理prompt发现候选且保留两份原文",
      ...organized,
      cueMembers: cueGroup?.memberCount,
    });
    if (
      cueGroup?.memberCount !== 2 ||
      !cueGroup.relations.some((r) => r.kind === "conflict") ||
      (await readMemoryScope(uid, prodId)).entries.length !== 3
    )
      throw new Error("整理器未保留并关联互斥cue采用关系");
    const unrelated = await turn(
      "今天先聊海报配色，我想要温暖、安静的感觉，给两个颜色组合即可。",
    );
    reports.push({ case: "跨会话无关主题不解决音响冲突", ...unrelated });
    if (unrelated.calls.includes("my.memory_resolve"))
      throw new Error("无关主题抢先解决冲突");
    const adopted = await turn(
      "我在排练时和导演对过了，现在正式采用《音响cue表v2》，旧表不再使用。确认一下以后音响和音乐cue应该去哪份查。",
    );
    memory = await readMemoryScope(uid, prodId);
    const groups = await readMemoryGroups(uid, prodId);
    reports.push({
      case: "相关任务根据明确新表达解决冲突",
      ...adopted,
      remainingRelations: groups.reduce((n, g) => n + g.relations.length, 0),
      activeEntries: memory.entries.length,
    });
    if (!adopted.calls.includes("my.memory_resolve"))
      throw new Error("已有依据但未进入组核对维护");
    console.log(JSON.stringify({ model: model.id, reports }, null, 2));
  } finally {
    await getPool().query("DELETE FROM agent_session WHERE user_id=$1", [uid]);
    await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [
      uid,
    ]);
    await cleanupProduction(prodId).catch(() => {});
    await getPool().end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "smoke失败");
  process.exitCode = 1;
});
