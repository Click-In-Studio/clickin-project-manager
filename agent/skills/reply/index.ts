import type { BotContext } from "../../types";
import type { SkillModule } from "../_types";
import { config } from "./config";
import { sendMessage, hasMarkdown, buildMarkdownCard } from "../../feishu";

export const replySkill: SkillModule<{ text: string }> = {
  config,
  run: async (ctx: BotContext, args: { text: string }) => {
    const { text } = args;
    const receiveId   = ctx.trigger.chatType === "p2p" ? ctx.trigger.senderId : ctx.trigger.chatId;
    const receiveType = ctx.trigger.chatType === "p2p" ? "open_id" : "chat_id";
    if (hasMarkdown(text)) {
      await sendMessage(receiveId, receiveType, "interactive", buildMarkdownCard(text));
    } else {
      await sendMessage(receiveId, receiveType, "text", JSON.stringify({ text }));
    }
  },
};
