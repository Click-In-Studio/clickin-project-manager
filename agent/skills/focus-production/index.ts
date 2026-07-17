import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { sendMessage, getChatMemberOpenIds } from "../../feishu";
import { getProductionsVisibleToAll } from "../../db";
import { config } from "./config";

type FocusProductionArgs = {
  // LLM provides names only; IDs are resolved from DB and never trusted from LLM
  candidates: { name: string; id?: string }[];
};

// Marker prefix embedded in button_value so processButtonClick can identify
// and handle this card's responses specially.
export const FOCUS_PRODUCTION_MARKER = "focus_production";

export const focusProductionSkill: SkillModule<FocusProductionArgs> = {
  config,
  async run(ctx: BotContext, args: FocusProductionArgs): Promise<void> {
    const names = Array.isArray(args?.candidates)
      ? args.candidates.map(c => c.name?.trim()).filter(Boolean)
      : [];
    if (names.length === 0) return;

    // Resolve real IDs from DB — never trust LLM-provided IDs
    const openIds = ctx.trigger.chatType === "group"
      ? (await getChatMemberOpenIds(ctx.trigger.chatId)).openIds
      : [ctx.trigger.senderId];
    const allProductions = await getProductionsVisibleToAll(openIds);

    // Match candidate names (case-insensitive, partial) against visible productions
    const lowerNames = names.map(n => n.toLowerCase());
    let resolved = allProductions.filter(p =>
      lowerNames.some(n => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase())),
    );
    // Fall back to all visible productions if none matched
    if (resolved.length === 0) resolved = allProductions;
    const candidates = resolved.slice(0, 5).map(p => ({ id: p.id, name: p.name }));
    if (candidates.length === 0) return;

    const sessionKey = ctx.trigger.chatType === "group"
      ? `group:${ctx.trigger.chatId}`
      : `${ctx.trigger.chatId}:${ctx.trigger.senderId}`;

    const candidateActions = candidates.map(c => ({
      tag:  "button",
      text: { tag: "plain_text", content: `《${c.name}》` },
      type: "primary",
      value: {
        session_key:  sessionKey,
        button_value: JSON.stringify({ marker: FOCUS_PRODUCTION_MARKER, production_id: c.id, production_name: c.name }),
        button_label: `《${c.name}》`,
      },
    }));

    const rejectAction = {
      tag:  "button",
      text: { tag: "plain_text", content: "以上都不是" },
      type: "danger",
      value: {
        session_key:  sessionKey,
        button_value: JSON.stringify({ marker: FOCUS_PRODUCTION_MARKER, rejected: true }),
        button_label: "以上都不是",
      },
    };

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title:    { tag: "plain_text", content: "确认当前 Production" },
        template: "blue",
      },
      elements: [
        {
          tag:     "markdown",
          content: "AI 推断你正在讨论以下 production，请点击确认，或选择「以上都不是」：",
        },
        {
          tag:     "action",
          actions: [...candidateActions, rejectAction],
        },
      ],
    };

    const receiveId     = ctx.trigger.chatType === "p2p" ? ctx.trigger.senderId : ctx.trigger.chatId;
    const receiveIdType = ctx.trigger.chatType === "p2p" ? "open_id" : "chat_id";
    await sendMessage(receiveId, receiveIdType, "interactive", JSON.stringify(card));
  },
};
