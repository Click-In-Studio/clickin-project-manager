// #1034 小规模真实模型 smoke：只用独立本地测试库与合成资料，不是可靠性 benchmark。
// 自动断言只覆盖基本条件和已见回归；合并正文、brief、摘要和回答仍须人工逐项审阅。
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
  const { readMemoryGroups, addMemoryRelations, readGroupPage } = await import(
    "../lib/agent/memory/memory-group-db"
  );
  const { organizeMemoryScope, summarizeMaterials, summarizeMemoryGroup } =
    await import("../lib/agent/memory/organize");
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
    const actions: Array<{ name: string; args: Record<string, unknown> }> = [];
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
          actions.push({ name: tool.mcpName, args: call.arguments });
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
      return { calls, actions, final, tokens };
    } finally {
      clearTimeout(timeout);
      await getPool().query(
        "UPDATE agent_run SET status='completed' WHERE id=$1",
        [runId],
      );
    }
  }
  async function confirmationSmoke() {
    const check = (ok: unknown, message: string) => {
      if (!ok) throw new Error(message);
    };
    const proposed = await turn("画外音有什么做法可以考虑？给我一个简短建议。");
    let memory = await readMemoryScope(uid, prodId);
    reports.push({
      case: "助手建议未被采纳不写入",
      ...proposed,
      memory: memory.entries,
    });
    check(memory.entries.length === 0, "把助手自行提出的方案写成了记忆");

    const stated = await turn(
      "已和导演确认：正式演出四位演员固定使用1—4号话筒，画外音方案还没定。",
    );
    memory = await readMemoryScope(uid, prodId);
    reports.push({
      case: "自然明确交代即可记录，不需重复确认",
      ...stated,
      memory: memory.entries,
    });
    check(
      stated.calls.includes("my.memory_write"),
      "用户明确交代后没有主动记录",
    );
    check(
      memory.entries.some(
        (e) => /四位演员/.test(e.body) && /话筒/.test(e.body),
      ),
      "漏记已确认的话筒配置",
    );

    const sufficient = await turn(
      "帮我把已经确定的话筒配置记完整。画外音究竟现场说还是录音放还没有定；如果记忆里必须补充什么，就先问我。",
    );
    memory = await readMemoryScope(uid, prodId);
    reports.push({
      case: "已有信息足够时不补写，不要求重复确认",
      ...sufficient,
      memory: memory.entries,
    });
    const missing = await turn("导演已经把画外音方案定了，帮我更新一下配置。");
    memory = await readMemoryScope(uid, prodId);
    reports.push({
      case: "新配置的必要信息缺失时先询问",
      ...missing,
      memory: memory.entries,
    });
    check(
      /？|\?|是否|请确认|需要确认|想确认|请告诉|请提供|请说明/.test(missing.final),
      "缺少信息却没有询问",
    );
    for (const entry of memory.entries) {
      const content = `${entry.body}\n${entry.brief}`;
      check(
        !/暂停|书面批准|现场判断/.test(content),
        "记忆中新增了用户未确认的执行要求",
      );
      check(
        !/画外音(?:方案)?(?:确定|决定|统一)?(?:采用|使用|改为)(?:预录|录音|现场)/.test(
          content,
        ),
        "画外音未定时自行选定了方案",
      );
    }

    const adopted = await turn(
      "导演已经确认：画外音采用预录，只在第五场使用，其他场次没有画外音，不走演员的1—4号话筒。",
    );
    memory = await readMemoryScope(uid, prodId);
    reports.push({
      case: "得到明确答复后写入，保留场次和否定范围",
      ...adopted,
      memory: memory.entries,
    });
    const content = memory.entries.map((e) => e.body).join("\n");
    check(
      /预录/.test(content) && /第五场/.test(content),
      "未保存已确认方案或丢失场次范围",
    );
    check(
      /其他场次.{0,5}(?:没有|无|不设|不用|不使用)/.test(content),
      "丢失其他场次没有画外音的否定条件",
    );
    check(
      /不走|不使用|不用|不占用|不经/.test(content),
      "丢失不走演员话筒的条件",
    );
  }
  async function semanticSmoke() {
    const create = (body: string, brief: string) =>
      mutateMemoryEntry(uid, prodId, {
        action: "create",
        actor: "agent",
        body,
        brief,
      });
    const clear = () =>
      getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [uid]);
    const check = (ok: unknown, message: string) => {
      if (!ok) throw new Error(message);
    };

    const a = await create(
      "导演已确认：正式演出音响与音乐cue以《音响cue表》为准。只有黑场切换允许在句中落音响cue，其他音响cue均在句间。",
      "正式演出音响音乐采用《音响cue表》，有黑场落点例外，正文有条件",
    );
    const b = await create(
      "正式演出音响与音乐cue采用《音响cue表》。技术联排暂用《联排工作表》，它不是正式演出依据；导演尚未批准正式演出采用新表的提议。",
      "正式演出采用《音响cue表》；技术联排另有工作表，新表只是提议",
    );
    await addMemoryRelations(uid, prodId, [
      {
        leftId: a,
        rightId: b,
        kind: "duplicate",
        reason: "同一正式采用约定的互补记录，需保留各自例外",
      },
    ]);
    const merged = await turn(
      "请按已经定下的安排，给舞监简述正式演出的音响、音乐cue来源和落点规则；技术联排是否一样？",
    );
    const mergedMemory = await readMemoryScope(uid, prodId);
    reports.push({
      case: "常规重复合并保留范围、否定和例外",
      ...merged,
      memory: mergedMemory.entries,
    });
    check(merged.calls.includes("my.memory_resolve"), "重复组没有核对维护");
    check(mergedMemory.entries.length === 1, "重复记录没有合并");
    const body = mergedMemory.entries[0].body;
    for (const term of [
      "音乐",
      "音响cue表",
      "黑场",
      "句中",
      "句间",
      "联排工作表",
    ])
      check(body.includes(term), `合并丢失条件：${term}`);
    check(/尚未|未获|未批|未被|未正式|待批/.test(body), "合并丢失尚未批准状态");

    await clear();
    const initial = [
      "2026-10-01导演确认：正式演出音响与音乐cue以《音响cue表》为准，这是已批准安排，不是技术联排的临时表。",
      ...Array.from(
        { length: 8 },
        (_, i) =>
          `2026-10-${String(10 + i).padStart(2, "0")}第${i + 1}次工作讨论记录：提议将正式演出主表换成《音响cue表v2》，仍待导演批准，尚未定案。重复出现的是建议，不是多次批准，不能据此认定旧表已经失效。`,
      ),
      "2026-10-04技术联排专用《联排工作表》，只是联排临时安排，不替换正式演出主表，不适用于正式演出。",
      "2026-10-05正式演出有一项例外：第七场画外音播放cue以《画外音补充表》为准，其他音响与音乐仍查正式主表；这不是所有场次的通用例外。",
      "2026-10-09声音设计师称导演口头同意正式演出主表改为《音响cue表v3》，未附导演记录。这与10月1日采用原表的说法有分歧；没有说明第七场画外音例外是否取消。",
    ];
    const entryIds: string[] = [];
    for (let i = 0; i < initial.length; i++)
      entryIds.push(await create(initial[i], `记录${i + 1}：${initial[i]}`));
    await addMemoryRelations(uid, prodId, [
      ...entryIds.slice(1).map((id, i) => ({
        leftId: entryIds[i],
        rightId: id,
        kind: i >= 1 && i <= 7 ? ("duplicate" as const) : ("conflict" as const),
        reason:
          "采用来源、适用范围或定案状态待核对；候选关系可能有误，连通不代表两两冲突",
      })),
      {
        leftId: entryIds[0],
        rightId: entryIds[11],
        kind: "conflict",
        reason: "同一正式演出主表：导演确认原表与转述口头采用v3存在直接分歧",
      },
    ]);
    const overview = (await readMemoryGroups(uid, prodId, [entryIds[0]]))[0];
    check(
      overview.summaryPending && !overview.entries.length,
      "未进入真实超限组摘要路径",
    );
    const entries = (await readMemoryScope(uid, prodId)).entries;
    const relationMap = new Map();
    for (let offset = 0; offset < entries.length; offset += 5) {
      const page = await readGroupPage(
        uid,
        prodId,
        overview.id,
        overview.revision,
        offset,
      );
      for (const r of page.group.relations) relationMap.set(r.id, r);
    }
    const fullMaterials = [
      {
        entries,
        relations: [...relationMap.values()],
        coverage: {
          offset: 0,
          currentEntries: entries.length,
          coveredEntries: entries.length,
          totalEntries: entries.length,
          complete: true,
        },
      },
    ];
    const full = await summarizeMaterials(fullMaterials);
    reports.push({
      case: "完整材料中立摘要",
      inputChars: JSON.stringify(fullMaterials).length,
      summaryChars: full.length,
      summary: full,
    });
    const assertSummary = (summary: string) => {
      for (const term of [
        "v2",
        "v3",
        "10-01",
        "10-09",
        "第七场",
        "画外音补充表",
        "联排工作表",
      ])
        check(summary.includes(term), `摘要丢失关键差异：${term}`);
      for (const index of [0, 9, 10, 11])
        check(
          summary.includes(entryIds[index]),
          `摘要丢失关键来源id：${index}`,
        );
      check(
        /待批|待.*批准|未.*批|尚未|未定案/.test(summary),
        "摘要丢失提议未批准状态",
      );
    };
    assertSummary(full);
    check(
      await summarizeMemoryGroup(uid, prodId, overview.id, overview.revision),
      "分页摘要提交失败",
    );
    const paged = (await readMemoryGroups(uid, prodId, [entryIds[0]]))[0];
    reports.push({
      case: "真实分页摘要再合并",
      pages: Math.ceil(entries.length / 5),
      summaryChars: paged.summary?.length,
      summary: paged.summary,
    });
    check(paged.summary, "分页后没有可用摘要");
    assertSummary(paged.summary!);
    check(
      !/未展示条目|正文缺失|覆盖仍不足/.test(paged.summary!),
      "整组已处理却继承了早期分页的缺失状态",
    );

    const uncertain = await turn(
      "为正式演出写一条给舞监的cue表使用说明。主表到底用哪份我这边还没核实，你先处理能确认的部分。",
    );
    const unresolved = await readMemoryGroups(uid, prodId, [entryIds[0]]);
    const uncertainMemory = (await readMemoryScope(uid, prodId)).entries;
    reports.push({
      case: "主模型读取大组、依据不足保持待核对",
      ...uncertain,
      remainingGroupSizes: unresolved.map((g) => g.memberCount),
      memory: uncertainMemory,
    });
    check(uncertain.calls.includes("my.memory_read"), "相关大组没有取原文核对");
    check(
      unresolved.some((g) => g.memberCount > 1),
      "依据不足却把全部分歧消除了",
    );
    check(
      /确认|核实|待定|待核对|尚未/.test(uncertain.final),
      "依据不足却未披露待核对状态",
    );
    const oldClaim = uncertainMemory.find((e) => e.id === entryIds[0]);
    const otherClaim = uncertainMemory.find((e) => e.id === entryIds[11]);
    check(
      oldClaim && otherClaim && oldClaim.groupId === otherClaim.groupId,
      "未解决的直接分歧被删掉或拆成孤立说法",
    );
    check(
      !/(?:先|仍|继续|暂)[^。\n]{0,10}(?:按|用|执行|以)[^。\n]{0,25}(?:音响cue表|第1条|旧表|原表)/.test(
        uncertain.final,
      ),
      "主表待核实时擅自选择了旧表作为执行依据",
    );
    check(
      !/(?:请以|须以|必须|需要|应当|需先|等到|只有|要求|一律以)[^。\n]{0,20}书面|在[^。\n]{0,12}书面确认前/.test(
        uncertain.final,
      ),
      "未获授权增加书面审批要求",
    );

    const confirmed = await turn(
      "我向导演核实了：正式演出主表仍用原《音响cue表》，v2和v3都没有获批；第七场画外音补充表例外保留，《联排工作表》只供技术联排。请整理成可执行说明。",
    );
    const finalMemory = await readMemoryScope(uid, prodId);
    const remaining = await readMemoryGroups(uid, prodId);
    reports.push({
      case: "明确答复后解决大组并保留条件",
      ...confirmed,
      memory: finalMemory.entries,
      groups: remaining.map((g) => ({
        id: g.id,
        size: g.memberCount,
        summaryPending: g.summaryPending,
      })),
    });
    check(
      confirmed.calls.includes("my.memory_resolve"),
      "明确答复后未维护待核对组",
    );
    check(
      remaining.every((g) => g.memberCount === 1),
      "明确答复后仍存在未处理关系组",
    );
    const finalBody = finalMemory.entries.map((e) => e.body).join("\n");
    for (const term of ["音响cue表", "第七场", "画外音补充表", "联排工作表"])
      check(finalBody.includes(term), `大组维护丢失条件：${term}`);
  }
  try {
    if (
      process.argv.includes("--semantics") ||
      process.argv.includes("--confirmation")
    ) {
      try {
        if (process.argv.includes("--confirmation")) await confirmationSmoke();
        else await semanticSmoke();
      } finally {
        console.log(
          JSON.stringify(
            { model: model.id, semanticReviewRequired: true, reports },
            null,
            2,
          ),
        );
      }
      return;
    }
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
    const cueGroup = candidates.find((g) => g.entries.some((e) => e.id === a));
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
