import { getPool } from "@/lib/pg";
import { attachmentIdsFromContext, stripUiContext } from "@/lib/agent/agent-ui-context";
import { listAttachmentsForHistory, type AgentAttachment } from "@/lib/agent/attachment-db";
import { TOOL_PAYLOAD_MAX_CHARS, type ChatHistoryPage } from "@/lib/agent/chat/types";
import { InMemorySessionStorage } from "../../../vendor/openclaw/packages/agent-core/src/harness/session/memory-storage";
import type { SessionTreeEntry } from "../../../vendor/openclaw/packages/agent-core/src/harness/types";
import { assistantFailureReason } from "./stream-lines";
import { pendingInputsForSession } from "./session-inbox";

export const CHAT_HISTORY_PAGE_SIZE = 30;

export function parseHistoryCursor(cursor: string | null): { head: number; before: number } | null {
  if (cursor === null) return null;
  const parts = cursor.split(".").map(Number);
  if (!/^\d+\.\d+$/.test(cursor) || parts.some(n => !Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) || parts[1] > parts[0]) {
    throw Object.assign(new Error("历史游标无效"), { status: 400 });
  }
  return { head: parts[0], before: parts[1] };
}

/** 聊天历史不经过模型压缩投影。树关系沿用 vendor，正文与附件只读取当前页。 */
export async function getHistoryPage(sessionId: string, cursor: string | null = null): Promise<ChatHistoryPage> {
  const position = parseHistoryCursor(cursor);
  // 这里只取树控制字段，不能把正文/工具结果/压缩摘要全量载入观看者进程。
  const headers = await getPool().query<{ seq: number; header: SessionTreeEntry }>(
    `SELECT seq, jsonb_build_object(
       'id', entry_id, 'parentId', parent_id, 'type', type,
       'appendMode', payload->'appendMode', 'targetId', payload->'targetId',
       'appendParentId', COALESCE(payload->'appendParentId', payload->'targetId')
     ) AS header FROM agent_session_entry
     WHERE session_id=$1 AND ($2::integer IS NULL OR seq <= $2) ORDER BY seq`,
    [sessionId, position?.head ?? null],
  );
  const head = position?.head ?? headers.rows.at(-1)?.seq ?? 0;
  const seqs = new Map(headers.rows.map(row => [row.header.id, row.seq]));
  const tree = new InMemorySessionStorage({ entries: headers.rows.map(row => row.header) });
  const path = await tree.getPathToRoot(await tree.getLeafId());
  const candidates = path.filter(entry => entry.type === "message" && (seqs.get(entry.id) ?? 0) < (position?.before ?? head + 1));
  const selected = candidates.slice(-CHAT_HISTORY_PAGE_SIZE);
  const rows = selected.length ? await getPool().query<{ entry_id: string; payload: SessionTreeEntry }>(
    `SELECT entry_id, payload FROM agent_session_entry WHERE session_id=$1 AND entry_id=ANY($2::text[]) ORDER BY seq`,
    [sessionId, selected.map(entry => entry.id)],
  ) : { rows: [] };
  const pending = position ? [] : await pendingInputsForSession(sessionId);
  const ids = new Set(pending.flatMap(entry => entry.attachment_ids));
  const calls: string[] = [];
  for (const { payload } of rows.rows) {
    if (payload.type !== "message") continue;
    const raw = textOf("content" in payload.message ? payload.message.content : "");
    for (const id of attachmentIdsFromContext(raw)) ids.add(id);
    for (const match of raw.matchAll(/\[\[attachment:([a-z0-9_]+)/gi)) ids.add(match[1]);
    if (payload.message.role === "toolResult") calls.push(payload.message.toolCallId);
  }
  const attachments = (await listAttachmentsForHistory(sessionId, [...ids], calls)).map(chatAttachment);
  const byId = new Map(attachments.map(item => [item.id, item]));
  const byCall = new Map<string, typeof attachments>();
  for (const item of attachments) if (item.sourceToolCallId) {
    const group = byCall.get(item.sourceToolCallId) ?? [];
    group.push(item);
    byCall.set(item.sourceToolCallId, group);
  }
  const messages: ChatHistoryPage["messages"] = [];
  for (const { entry_id, payload } of rows.rows) {
    if (payload.type !== "message") continue;
    const message = payload.message;
    const raw = textOf("content" in message ? message.content : "");
    if (message.role === "user") {
      const content = stripUiContext(raw);
      const attached = attachmentIdsFromContext(raw).flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
      if (content) messages.push({ key: `${seqs.get(entry_id)}:${entry_id}:user`, role: "user", content, ...(attached.length ? { attachments: attached } : {}) });
    } else if (message.role === "toolResult") {
      const result = raw.slice(0, TOOL_PAYLOAD_MAX_CHARS);
      const attached = byCall.get(message.toolCallId) ?? [];
      messages.push({ key: `${seqs.get(entry_id)}:${entry_id}:tool`, role: "tool", name: message.toolName, id: message.toolCallId || undefined,
        ...(result ? { result } : {}), ...(attached.length ? { attachments: attached } : {}) });
    } else if (message.role === "assistant") {
      const thinking = message.content.filter(part => part.type === "thinking" && !part.redacted)
        .map(part => part.type === "thinking" ? part.thinking : "").join("");
      if (thinking) messages.push({ key: `${seqs.get(entry_id)}:${entry_id}:thinking`, role: "thinking", content: thinking });
      if (raw) messages.push({ key: `${seqs.get(entry_id)}:${entry_id}:assistant`, role: "assistant", content: raw });
      const failure = assistantFailureReason(message);
      if (failure) messages.push({ key: `${seqs.get(entry_id)}:${entry_id}:notice`, role: "notice", content: failure });
    }
  }
  for (const entry of pending) messages.push({
    key: `${entry.id}:user`, role: "user", content: stripUiContext(entry.message),
    attachments: entry.attachment_ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []),
  });
  return { messages, attachments, nextCursor: candidates.length > selected.length && selected.length
    ? `${head}.${seqs.get(selected[0].id)}` : null };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text").map(part => String(part.text ?? "")).join("");
}

function chatAttachment(a: AgentAttachment): ChatHistoryPage["attachments"][number] {
  return { id: a.id, fileName: a.fileName, mimeType: a.mimeType, mediaKind: a.mediaKind,
    ...(a.status !== "ready" ? { status: a.status } : {}),
    ...(a.releaseUntil ? { releaseUntil: a.releaseUntil } : {}),
    ...(a.promotedAssetId ? { promotedAssetId: a.promotedAssetId } : {}),
    ...(a.sourceToolCallId ? { sourceToolCallId: a.sourceToolCallId } : {}),
  };
}
