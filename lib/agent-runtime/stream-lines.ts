// harness 事件 → 现有前端 SSE 行协议（#367 S1 判据④：前端零改动）。
//
// 契约来源 = lib/agent-gateway/stream-reducer.ts 的 StreamLine：
//   delta   = 当前"段"的累计正文（不是增量！reducer 用它整体替换气泡文本）
//   tool    = 段边界：工具调用开始，其后的正文属于新段
//   final   = 最后一段的正文；aborted / error 同理收尾
// 段语义与 relay.ts 一致（一次工具调用切一段），但这里天然是累计值：
// agent-loop 的 message_update 带的是应用过 delta 之后的完整 assistant 消息，
// 不存在 gateway 时代"快照与裸增量并存要去重"的问题——赋值即幂等。

import type { StreamLine } from "@/lib/agent-gateway/stream-reducer";
import { TOOL_PAYLOAD_MAX_CHARS } from "@/lib/agent-gateway/types";
import type { AgentHarnessEvent } from "../../vendor/openclaw/packages/agent-core/src/harness/types";
import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";

/** 与 relay.boundToolPayload 同款大小闸（不 import relay：它拖着 gateway client 依赖树）。 */
export function boundPayload(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    if (serialized.length <= TOOL_PAYLOAD_MAX_CHARS) return value;
    return { truncated: true, preview: serialized.slice(0, TOOL_PAYLOAD_MAX_CHARS) };
  } catch {
    return undefined;
  }
}

function assistantText(message: AgentMessage): string | null {
  if (message.role !== "assistant") return null;
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** 工具结果给前端看的形态：文本块拼成字符串（与 gateway 时代 toolResult 为文本一致）。 */
function toolResultForClient(result: unknown): unknown {
  const r = result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  if (r && Array.isArray(r.content)) {
    const text = r.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
    return text;
  }
  return result;
}

/**
 * 返回一个 harness 事件处理器；每个前端可见的变化以 StreamLine 形式经 emit 送出。
 * 用法：`harness.subscribe(createStreamLineAdapter(send))`。
 */
export function createStreamLineAdapter(emit: (line: StreamLine) => void): (event: AgentHarnessEvent) => void {
  let segmentText = "";
  let lastDelta: string | null = null;

  const pushDelta = (text: string) => {
    if (!text || text === lastDelta) return;
    lastDelta = text;
    segmentText = text;
    emit({ type: "delta", text });
  };

  return (event) => {
    switch (event.type) {
      case "message_update": {
        const text = assistantText(event.message);
        if (text !== null) pushDelta(text);
        return;
      }
      case "message_end": {
        // 流末权威值（provider 的 done 消息可能比最后一次 update 多几个字）
        const text = assistantText(event.message);
        if (text !== null) pushDelta(text);
        return;
      }
      case "tool_execution_start": {
        emit({ type: "tool", name: event.toolName, id: event.toolCallId, ...(event.args !== undefined ? { input: boundPayload(event.args) } : {}) });
        segmentText = "";
        lastDelta = null;
        return;
      }
      case "tool_execution_end": {
        const result = boundPayload(toolResultForClient(event.result));
        emit({ type: "tool-result", id: event.toolCallId, ...(result !== undefined ? { result } : {}), ...(event.isError ? { isError: true } : {}) });
        emit({ type: "tool-end", id: event.toolCallId });
        return;
      }
      case "agent_end": {
        const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted") {
          emit({ type: "aborted", text: segmentText });
          return;
        }
        if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
          emit({ type: "error", error: lastAssistant.errorMessage || "Agent run did not complete" });
          return;
        }
        emit({ type: "final", text: segmentText });
        return;
      }
      default:
        return;
    }
  };
}
