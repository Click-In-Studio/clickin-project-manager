import type { BotContext } from "../../types";
import type { SkillModule } from "../_types";
import { config } from "./config";
import { getMessage } from "../../feishu";

type ViewCardArgs = { message_id: string };

// Walk an unknown JSON value and collect all human-readable text strings.
function extractText(node: unknown, depth = 0): string[] {
  if (depth > 10) return []; // guard against deeply nested structures
  if (typeof node === "string" && node.trim()) return [node.trim()];
  if (Array.isArray(node)) return node.flatMap(n => extractText(n, depth + 1));
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const tag = obj.tag as string | undefined;
    const lines: string[] = [];

    // Named text fields in Feishu card elements
    for (const key of ["content", "text", "title", "placeholder"] as const) {
      if (typeof obj[key] === "string" && (obj[key] as string).trim()) {
        lines.push((obj[key] as string).trim());
      }
    }
    // Recurse into container fields (skip keys already handled above)
    for (const key of Object.keys(obj)) {
      if (["content", "text", "title", "placeholder", "tag", "type", "template", "style"].includes(key)) continue;
      lines.push(...extractText(obj[key], depth + 1));
    }
    // Prefix action-button text so the LLM knows it's a button
    if (tag === "button" && lines.length) {
      return [`[按钮] ${lines.join(" ")}`];
    }
    return lines;
  }
  return [];
}

function parseCardContent(raw: string): string {
  let card: unknown;
  try {
    card = JSON.parse(raw);
  } catch {
    return raw; // not JSON, return as-is
  }

  const lines: string[] = [];
  if (card && typeof card === "object") {
    const obj = card as Record<string, unknown>;

    // Header title
    const headerTitle =
      (obj.header as Record<string, unknown> | undefined)?.title;
    if (headerTitle) {
      const titleText = extractText(headerTitle).join(" ");
      if (titleText) lines.push(`【标题】${titleText}`);
    }

    // Body elements (v1 card: elements at root; v2: body.elements)
    const elements =
      (obj.body as Record<string, unknown> | undefined)?.elements ??
      obj.elements;
    if (Array.isArray(elements)) {
      for (const el of elements) {
        lines.push(...extractText(el));
      }
    }
  }

  return lines.length ? lines.join("\n") : raw;
}

export const viewCardSkill: SkillModule<ViewCardArgs> = {
  config,
  run: async (_ctx: BotContext, args: ViewCardArgs): Promise<string> => {
    const { message_id } = args;
    const msg = await getMessage(message_id);
    if (msg.msgType !== "interactive") {
      return `消息 ${message_id} 类型为 ${msg.msgType}，内容：${msg.content}`;
    }
    const readable = parseCardContent(msg.content);
    return `卡片内容（message_id: ${message_id}）：\n${readable}`;
  },
};
