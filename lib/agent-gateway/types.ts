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

export type ChatTranscriptEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  // result：toolResult 历史条目自身的文本内容（调用结果）。参数在
  // chat.history 里不存在（assistant 消息没有 toolCall 块），只有实时流有。
  | { role: "tool"; name: string; id?: string; result?: string };
