// 中途 run 的恢复（#367 提案 §4.4 ①）：进程崩溃/重启后，从持久化 transcript
// 判定该会话停在哪一步，把 transcript 修成"可续跑"形态，再由调用方
// harness.continueTurn() 续跑。
//
// 三种中断点 → 三种处理（与提案表格一一对应）：
//   模型调用进行中   最后一条是 user/toolResult（半截 assistant 从未 message_end，
//                    根本没落库）→ 直接续跑 = 重发同一次模型调用，幂等
//   工具执行进行中   最后一条是 assistant(toolUse)，缺 toolResult → 只读工具重跑
//                    补真结果；写工具**不重跑**，补"状态未知"错误结果交给模型
//   assistant 已收尾  stop/error/aborted → idle，无事可做
//
// 纯函数化：只依赖 Session（vendor agent-core）与工具表，不碰 DB/HTTP，可离线测。

import type { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session.js";
import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "../../vendor/openclaw/packages/agent-core/src/types.js";
import type { ToolCall, ToolResultMessage } from "../../vendor/openclaw/packages/llm-core/src/types.js";

/** 运行时工具 = agent-core 工具 + 我们的只读标记（决定中断后能否盲重跑）。 */
export type RuntimeTool = AgentTool & {
  /** 无副作用、可重复执行（对应 MCP 时代的 readOnlyHint）。写工具不保证幂等。 */
  readOnly: boolean;
};

export const UNKNOWN_STATE_TOOL_RESULT =
  "该工具调用在执行途中被系统重启中断，执行状态未知（副作用可能已发生也可能没有）。" +
  "请先用只读工具查询确认实际状态，再决定是否需要重新执行；不要假设它成功或失败。";

export type PendingRepair = {
  toolCallId: string;
  toolName: string;
  action: "re-executed" | "unknown-state" | "tool-missing";
};

export type ResumeDecision =
  | { kind: "idle"; reason: "empty" | "assistant-finished" }
  | { kind: "continue"; repaired: PendingRepair[] };

function isToolCall(c: unknown): c is ToolCall {
  return typeof c === "object" && c !== null && (c as { type?: string }).type === "toolCall";
}

function toolResultMessage(
  call: ToolCall,
  result: AgentToolResult<unknown>,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
  };
}

/**
 * 找出最后一条 assistant 消息里没有对应 toolResult 的 toolCall。
 * 只看"最后一条 assistant 之后"的 toolResult——更早的配对与本次中断无关。
 */
export function findPendingToolCalls(messages: AgentMessage[]): ToolCall[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return [];
  const assistant = messages[lastAssistantIdx];
  if (assistant.role !== "assistant" || assistant.stopReason !== "toolUse") return [];
  const answered = new Set<string>();
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "toolResult") answered.add(m.toolCallId);
  }
  return assistant.content.filter(isToolCall).filter((c) => !answered.has(c.id));
}

/**
 * 修复 transcript 并给出续跑判定。修复动作（补 toolResult）直接落 session，
 * 调用方随后 harness.continueTurn()。
 */
export async function repairAndClassify(
  session: Session,
  tools: ReadonlyMap<string, RuntimeTool>,
  opts: { signal?: AbortSignal } = {},
): Promise<ResumeDecision> {
  const { messages } = await session.buildContext();
  if (messages.length === 0) return { kind: "idle", reason: "empty" };

  const pending = findPendingToolCalls(messages);
  const repaired: PendingRepair[] = [];
  for (const call of pending) {
    const tool = tools.get(call.name);
    if (!tool) {
      await session.appendMessage(
        toolResultMessage(call, { content: [{ type: "text", text: `工具 ${call.name} 已不存在。` }], details: undefined }, true),
      );
      repaired.push({ toolCallId: call.id, toolName: call.name, action: "tool-missing" });
      continue;
    }
    if (tool.readOnly) {
      let result: AgentToolResult<unknown>;
      let isError = false;
      try {
        result = await tool.execute(call.id, call.arguments as never, opts.signal);
      } catch (err) {
        result = { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], details: undefined };
        isError = true;
      }
      await session.appendMessage(toolResultMessage(call, result, isError));
      repaired.push({ toolCallId: call.id, toolName: call.name, action: "re-executed" });
      continue;
    }
    // 写工具：副作用不可知，不盲重放（#367 §10-12 定谳）
    await session.appendMessage(
      toolResultMessage(call, { content: [{ type: "text", text: UNKNOWN_STATE_TOOL_RESULT }], details: undefined }, true),
    );
    repaired.push({ toolCallId: call.id, toolName: call.name, action: "unknown-state" });
  }

  const after = (await session.buildContext()).messages;
  const last = after[after.length - 1];
  if (last.role === "assistant") return { kind: "idle", reason: "assistant-finished" };
  return { kind: "continue", repaired };
}
