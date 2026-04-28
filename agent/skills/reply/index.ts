import type { BotContext } from "../../types";
import type { SkillModule } from "../_types";
import { config } from "./config";
import { sendMessage } from "../../feishu";

export const replySkill: SkillModule<{ text: string }> = {
  config,
  run: async (ctx: BotContext, args: { text: string }) => {
    const { text } = args;
    if (ctx.trigger.chatType === "p2p") {
      await sendMessage(ctx.trigger.senderId, "open_id", "text", JSON.stringify({ text }));
    } else {
      await sendMessage(ctx.trigger.chatId, "chat_id", "text", JSON.stringify({ text }));
    }
  },
};
