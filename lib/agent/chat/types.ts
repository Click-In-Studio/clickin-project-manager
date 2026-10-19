export interface ChatSessionSummary {
  key: string;
  modelSelection?: import("../model-types").ModelSelection;
  title: string;
  lastMessagePreview?: string;
  updatedAt?: number;
  pendingQuestionCount?: number;
  latestQuestionAt?: number;
  status?: "queued" | "running" | "compacting" | "done" | "failed" | "killed" | "timeout";
}

// 工具参数/结果对外透传（SSE 帧、历史 JSON）前的统一截断上限——relay 的
// 大小闸与历史分页的投影共用，防止两处各写字面量后静默漂移。
export const TOOL_PAYLOAD_MAX_CHARS = 16_000;

export type ChatAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  mediaKind: string | null;
  status?: "pending" | "ready" | "released" | "deleting" | "expired" | "promoted";
  releaseUntil?: string | null;
  promotedAssetId?: string | null;
  sourceToolCallId?: string | null;
};

export type ChatTranscriptEntry =
  | { role: "user"; content: string; attachments?: ChatAttachment[] }
  | { role: "assistant"; content: string }
  | { role: "thinking"; content: string }
  | { role: "notice"; content: string }
  // result：toolResult 历史条目自身的文本内容（调用结果）。参数在
  // chat.history 里不存在（assistant 消息没有 toolCall 块），只有实时流有。
  | { role: "tool"; name: string; id?: string; result?: string; attachments?: ChatAttachment[] };

/** 游标固定本次浏览的树快照；消息 key 在历史分页与刷新间保持不变。 */
export type ChatHistoryPage = {
  messages: (ChatTranscriptEntry & { key: string })[];
  attachments: ChatAttachment[];
  nextCursor: string | null;
};
