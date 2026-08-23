export type GatewayStatus =
  | { state: "unconfigured" }
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "pairing_required"; requestId?: string }
  | { state: "error"; error: string };

export interface ChatSessionSummary {
  key: string;
  title: string;
  lastMessagePreview?: string;
  updatedAt?: number;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
}

// 工具参数/结果对外透传（SSE 帧、历史 JSON）前的统一截断上限——relay 的
// 大小闸与 getChatHistory 的历史截断共用，防止两处各写字面量后静默漂移。
export const TOOL_PAYLOAD_MAX_CHARS = 16_000;

export type ChatTranscriptEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  // result：toolResult 历史条目自身的文本内容（调用结果）。参数在
  // chat.history 里不存在（assistant 消息没有 toolCall 块），只有实时流有。
  | { role: "tool"; name: string; id?: string; result?: string };
