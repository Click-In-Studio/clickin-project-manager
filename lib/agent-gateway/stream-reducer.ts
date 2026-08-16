// 聊天流事件 → 气泡列表的纯 reducer。从 AgentChatClient 抽出以便直接
// 单测（仓库无组件测试设施）；组件侧只负责 IO/状态，渲染语义全在这里。

export type ApprovalInfo = {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  allowedDecisions: string[];
  // 关联的 MCP 工具调用 id——同一字段名/来源同 client.ts 的 ApprovalRequest，
  // 已经随 relay 原样 JSON 序列化过来了，这里补声明才能让前端读它（如
  // WikiProposalPreviewModal 按它拉取完整提议详情）。
  toolCallId?: string;
};

export type Bubble =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; name: string; id?: string; done: boolean }
  | { kind: "approval"; approval: ApprovalInfo; decision?: string; resolving?: boolean }
  | { kind: "notice"; text: string };

export type StreamLine =
  | { type: "delta"; text: string }
  | { type: "final"; text: string; fallback?: boolean }
  | { type: "aborted"; text: string }
  | { type: "error"; error: string }
  | { type: "tool"; name?: string; id?: string }
  | { type: "tool-end"; id?: string }
  | { type: "approval"; approval?: ApprovalInfo }
  | { type: "approval-resolved"; id?: string; decision?: string }
  | { type: "ping" }
  | { type: "session"; key?: string };

function lastAssistantText(bubbles: Bubble[]): string | undefined {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (b.kind === "assistant") return b.text;
  }
  return undefined;
}

/** Applies one stream line to the bubble list, returning the next list.
 * Non-rendering lines (ping/session) return the input unchanged. */
export function applyStreamLine(prev: Bubble[], line: StreamLine): Bubble[] {
  const next = [...prev];
  const last = next[next.length - 1];
  switch (line.type) {
    case "delta": {
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: line.text, streaming: true };
      } else {
        next.push({ kind: "assistant", text: line.text, streaming: true });
      }
      return next;
    }
    case "tool": {
      // Current streaming segment (if any) is settled by this tool call.
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: last.text };
      }
      next.push({ kind: "tool", name: line.name || "工具", id: line.id, done: false });
      return next;
    }
    case "tool-end": {
      for (let i = next.length - 1; i >= 0; i--) {
        const b = next[i];
        if (b.kind === "tool" && !b.done && (!line.id || b.id === line.id)) {
          next[i] = { ...b, done: true };
          break;
        }
      }
      return next;
    }
    case "final": {
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: line.text || last.text };
      } else if (line.text) {
        // 只有服务端标记为 fallback 的 final（chat.history 兜底，可能是
        // 上一轮已渲染的旧文本）才做去重；正常 final 即使与上一条回复
        // 文本相同（用户重问同一问题等）也照常渲染。
        if (line.fallback && lastAssistantText(next) === line.text) return next;
        next.push({ kind: "assistant", text: line.text });
      }
      return next;
    }
    case "approval": {
      if (!line.approval) return next;
      // Settle the current streaming segment; the gate pauses the run.
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: last.text };
      }
      next.push({ kind: "approval", approval: line.approval });
      return next;
    }
    case "approval-resolved": {
      for (let i = next.length - 1; i >= 0; i--) {
        const b = next[i];
        if (b.kind === "approval" && b.approval.id === line.id) {
          next[i] = { ...b, decision: line.decision || "unknown", resolving: false };
          break;
        }
      }
      return next;
    }
    case "aborted": {
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: last.text };
      }
      next.push({ kind: "notice", text: "已中止" });
      return next;
    }
    case "error": {
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: last.text };
      }
      next.push({ kind: "notice", text: line.error || "出错了" });
      return next;
    }
    default:
      return next; // ping/session 等非渲染事件
  }
}
