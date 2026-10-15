// harness 事件 → 现有前端 SSE 行协议（#367 S1 判据④：前端零改动）。
//
// 契约来源 = lib/agent/chat/stream-reducer.ts 的 StreamLine（网关时代在
// lib/agent-gateway/，随 #377 一起退役，行协议原样搬过来）：
//   delta   = 当前"段"的累计正文（不是增量！reducer 用它整体替换气泡文本）
//   tool    = 段边界：工具调用开始，其后的正文属于新段
//   final   = 最后一段的正文；aborted / error 同理收尾
// 段语义与 relay.ts 一致（一次工具调用切一段），但这里天然是累计值：
// agent-loop 的 message_update 带的是应用过 delta 之后的完整 assistant 消息，
// 不存在 gateway 时代"快照与裸增量并存要去重"的问题——赋值即幂等。

import type { StreamLine } from "@/lib/agent/chat/stream-reducer";
import { TOOL_PAYLOAD_MAX_CHARS } from "@/lib/agent/chat/types";
import type { AgentHarnessEvent } from "../../../vendor/openclaw/packages/agent-core/src/harness/types";
import type { AgentMessage } from "../../../vendor/openclaw/packages/agent-core/src/types";

/** 长度截断与模型错误共用终态原因，实时流、历史和子任务保持一致。 */
export function assistantFailureReason(message: AgentMessage | undefined): string | undefined {
  if (message?.role !== "assistant") return undefined;
  if (message.stopReason === "length") return "本次回复达到生成长度上限，尚未完成。已有内容已保留，请核对进度后再继续。";
  if (message.stopReason === "error") return message.errorMessage || "模型请求失败，请重试";
  return undefined;
}

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

function assistantThinking(message: AgentMessage): string | null {
  if (message.role !== "assistant") return null;
  return message.content
    .filter((c): c is { type: "thinking"; thinking: string; redacted?: boolean } => c.type === "thinking")
    .filter((c) => !c.redacted)
    .map((c) => c.thinking)
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

function toolAttachmentsForClient(result: unknown): import("@/lib/agent/chat/types").ChatAttachment[] {
  const details = (result as { details?: { attachments?: unknown } } | undefined)?.details;
  if (!Array.isArray(details?.attachments)) return [];
  return details.attachments.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (typeof item.attachmentId !== "string" || typeof item.fileName !== "string" || typeof item.mimeType !== "string") return [];
    return [{ id: item.attachmentId, fileName: item.fileName, mimeType: item.mimeType,
      mediaKind: item.mimeType.startsWith("image/") ? "image" : null, status: "ready" as const,
      sourceToolCallId: null }];
  });
}

/**
 * 返回一个 harness 事件处理器；每个前端可见的变化以 StreamLine 形式经 emit 送出。
 * 用法：`harness.subscribe(createStreamLineAdapter(send))`。
 */
export function createStreamLineAdapter(emit: (line: StreamLine) => void): (event: AgentHarnessEvent) => void {
  let segmentText = "";
  let lastDelta: string | null = null;
  let lastThinking: string | null = null;

  const pushDelta = (text: string) => {
    if (!text || text === lastDelta) return;
    lastDelta = text;
    segmentText = text;
    emit({ type: "delta", text });
  };

  const pushThinking = (text: string) => {
    if (!text || text === lastThinking) return;
    lastThinking = text;
    emit({ type: "thinking", text });
  };

  return (event) => {
    switch (event.type) {
      case "message_update": {
        const thinking = assistantThinking(event.message);
        if (thinking !== null) pushThinking(thinking);
        const text = assistantText(event.message);
        if (text !== null) pushDelta(text);
        return;
      }
      case "message_end": {
        // 流末权威值（provider 的 done 消息可能比最后一次 update 多几个字）
        const thinking = assistantThinking(event.message);
        if (thinking !== null) pushThinking(thinking);
        const text = assistantText(event.message);
        if (text !== null) pushDelta(text);
        return;
      }
      case "tool_execution_start": {
        emit({ type: "tool", name: event.toolName, id: event.toolCallId, ...(event.args !== undefined ? { input: boundPayload(event.args) } : {}) });
        segmentText = "";
        lastDelta = null;
        lastThinking = null;
        return;
      }
      case "tool_execution_update": {
        const partial = event.partialResult as { progress?: { text?: unknown; visibility?: unknown; privacy?: unknown } } | undefined;
        const progress = partial?.progress;
        if (progress?.visibility === "channel" && progress.privacy === "public" && typeof progress.text === "string" && progress.text) {
          emit({ type: "tool-progress", id: event.toolCallId, text: progress.text.slice(0, 300) });
        }
        return;
      }
      case "tool_execution_end": {
        const result = boundPayload(toolResultForClient(event.result));
        const attachments = toolAttachmentsForClient(event.result);
        emit({ type: "tool-result", id: event.toolCallId, ...(result !== undefined ? { result } : {}),
          ...(attachments.length ? { attachments } : {}), ...(event.isError ? { isError: true } : {}) });
        emit({ type: "tool-end", id: event.toolCallId });
        return;
      }
      case "agent_end": {
        const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted") {
          emit({ type: "aborted", text: segmentText });
          return;
        }
        const failure = assistantFailureReason(lastAssistant);
        if (failure) {
          emit({ type: "error", error: failure });
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
