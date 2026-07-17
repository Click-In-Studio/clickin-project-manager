import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import type { AgentComment } from "../../db-script";
import { config } from "./config";
import { getMentionsToday } from "../../db-script";

type Args = Record<string, never>;

function formatMention(c: AgentComment, index: number): string {
  const time = new Date(c.createdAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const replyTag = c.parentId ? " [回复]" : "";
  return `${index + 1}. Block ${c.contextId}  [${c.authorName}] ${time}${replyTag}\n   ${c.body}`;
}

export const getMyMentionsSkill: SkillModule<Args> = {
  config,
  async run(ctx: BotContext, _args: Args): Promise<string> {
    const productionId = ctx.productionContext?.productionId;
    if (!productionId) return "❌ 未设置当前 production，请先调用 focus_production。";

    const openId = ctx.trigger.senderId;
    const mentions = await getMentionsToday(productionId, openId);
    if (mentions.length === 0) return "今天还没有 @你 的评论。";

    const lines = [
      `今天共 ${mentions.length} 条 @你 的评论：`,
      "",
      ...mentions.map(formatMention),
    ];
    return lines.join("\n");
  },
};
