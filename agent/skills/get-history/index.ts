import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { getChatMessages } from "../../feishu";
import type { ChatHistoryMessage } from "../../feishu";
import { config } from "./config";

type GetHistoryArgs = {
  count?: number;
};

function formatMessages(messages: ChatHistoryMessage[]): string {
  if (messages.length === 0) return "（无消息记录）";
  return messages
    .map(m => {
      const d = new Date(m.timestamp + 8 * 3_600_000);
      const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      const who = m.senderType === "app" ? "助手" : m.senderName;
      const body =
        m.type === "text"  ? (m.text ?? "") :
        m.type === "card"  ? `[系统卡片: ${m.cardTitle} | message_id: ${m.messageId}]` :
        `[其他消息 | message_id: ${m.messageId}]`;
      return `[${hhmm}] ${who}: ${body}`;
    })
    .join("\n");
}

export const getHistorySkill: SkillModule<GetHistoryArgs> = {
  config,
  async run(ctx: BotContext, args: GetHistoryArgs): Promise<string> {
    const count = Math.min(Math.max(args?.count ?? 10, 1), 50);
    const messages = await getChatMessages(ctx.trigger.chatId, count);
    return formatMessages(messages);
  },
};
