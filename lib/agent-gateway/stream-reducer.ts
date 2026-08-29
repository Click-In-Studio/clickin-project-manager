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

// ask_user 问题卡片的数据形状（与 lib/agent-gateway/client.ts 的
// AgentQuestionRecord 对应，经 relay 原样 JSON 序列化过来）。
export type QuestionOption = { label: string; description?: string };
export type QuestionItem = {
  questionId: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
};
export type QuestionInfo = {
  id: string;
  questions: QuestionItem[];
  expiresAtMs?: number;
};

export type Bubble =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  // input/result：调用参数与结果（relay 超限时为 {truncated, preview} 包裹），
  // 供气泡点开看详情；历史回放只有 result 文本，input 恒缺席。
  | { kind: "tool"; name: string; id?: string; done: boolean; input?: unknown; result?: unknown; isError?: boolean }
  | { kind: "approval"; approval: ApprovalInfo; decision?: string; resolving?: boolean }
  // status：answered/cancelled/expired；未定 = 待答卡片
  | { kind: "question"; question: QuestionInfo; status?: string; resolving?: boolean }
  | { kind: "notice"; text: string };

export type StreamLine =
  | { type: "delta"; text: string }
  | { type: "final"; text: string; fallback?: boolean }
  | { type: "aborted"; text: string }
  | { type: "error"; error: string }
  | { type: "tool"; name?: string; id?: string; input?: unknown }
  | { type: "tool-result"; id?: string; result?: unknown; isError?: boolean }
  | { type: "tool-end"; id?: string }
  | { type: "approval"; approval?: ApprovalInfo }
  | { type: "approval-resolved"; id?: string; decision?: string }
  | { type: "question"; question?: QuestionInfo }
  | { type: "question-resolved"; id?: string; status?: string }
  | { type: "ping" }
  | { type: "session"; key?: string }
  // 写工具成功后的变更信号（自建运行时 #367）：不进气泡，AgentPopout 派发给页面订阅者
  // 决定怎么刷（lib/agent-mutations.ts）。与 tool-end 一样落 agent_event，断线重连可补。
  | { type: "mutation"; scope: string; action: "created" | "updated" | "deleted"; productionId?: string | null; ids?: string[]; tool?: string };

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
      next.push({ kind: "tool", name: line.name || "工具", id: line.id, done: false, ...(line.input !== undefined ? { input: line.input } : {}) });
      return next;
    }
    case "tool-result": {
      // 结果先于 done 标记到达（gateway 的 tool 流早于 item 流的 end）。
      // 只按 id 精确归并；无 id 一律丢弃——gateway 的 result 事件恒带
      // toolCallId，无 id 说明链路异常，此时并发多调用下"猜最后一个未完成
      // 气泡"（tool-end 的兜底）会把结果安到错误的调用上：done 标记错了
      // 只差一个勾，结果文本错了是实打实的张冠李戴，宁缺毋滥。
      if (!line.id) return next;
      for (let i = next.length - 1; i >= 0; i--) {
        const b = next[i];
        if (b.kind === "tool" && b.id === line.id) {
          next[i] = {
            ...b,
            ...(line.result !== undefined ? { result: line.result } : {}),
            ...(line.isError ? { isError: true } : {}),
          };
          break;
        }
      }
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
      // 兜底路径产出的东西必须和正常路径可区分：流在工具/提问还没收尾时
      // 就以兜底 final 结束，说明本轮被掐断过——文本可能只是中间发言，
      // 明确提示，别把它伪装成一次正常完成。去重早退的分支也要带上。
      const withFallbackNotice = (list: Bubble[]): Bubble[] => {
        if (!line.fallback) return list;
        const interrupted = list.some(
          (b) => (b.kind === "tool" && !b.done) || (b.kind === "question" && !b.status),
        );
        return interrupted ? [...list, { kind: "notice", text: "本轮回复以兜底方式收尾，内容可能不完整" }] : list;
      };
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: line.text || last.text };
      } else if (line.text) {
        // 只有服务端标记为 fallback 的 final（chat.history 兜底，可能是
        // 上一轮已渲染的旧文本）才做去重；正常 final 即使与上一条回复
        // 文本相同（用户重问同一问题等）也照常渲染。
        if (line.fallback && lastAssistantText(next) === line.text) return withFallbackNotice(next);
        next.push({ kind: "assistant", text: line.text });
      }
      return withFallbackNotice(next);
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
    case "question": {
      if (!line.question?.id || !Array.isArray(line.question.questions) || line.question.questions.length === 0) {
        return next;
      }
      // 同一问题可能既来自 question.list 恢复又来自实时事件——按 id 去重。
      if (next.some((b) => b.kind === "question" && b.question.id === line.question!.id)) return next;
      // Settle the current streaming segment; the run is blocked on the answer.
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { kind: "assistant", text: last.text };
      }
      next.push({ kind: "question", question: line.question });
      return next;
    }
    case "question-resolved": {
      for (let i = next.length - 1; i >= 0; i--) {
        const b = next[i];
        if (b.kind === "question" && b.question.id === line.id) {
          next[i] = { ...b, status: line.status || "answered", resolving: false };
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
