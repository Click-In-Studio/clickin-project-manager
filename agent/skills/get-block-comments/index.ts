import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import type { AgentComment } from "../../db-script";
import { config } from "./config";
import { getBlockComments } from "../../db-script";

type Args = { block_id: string };

function formatComment(c: AgentComment, index: number): string {
  const mentions = c.mentions.length > 0
    ? `  @: ${c.mentions.map(m => m.name).join("、")}`
    : "";
  const time = new Date(c.createdAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const replyTag = c.parentId ? " [回复]" : "";
  return `${index + 1}. [${c.authorName}] ${time}${replyTag}\n   ${c.body}${mentions}`;
}

export const getBlockCommentsSkill: SkillModule<Args> = {
  config,
  async run(ctx: BotContext, args: Args): Promise<string> {
    const productionId = ctx.productionContext?.productionId;
    if (!productionId) return "❌ 未设置当前 production，请先调用 focus_production。";

    const blockId = args?.block_id?.trim();
    if (!blockId) return "❌ 缺少 block_id 参数。";
    if (!/^[0-9a-f-]{8,}$/i.test(blockId))
      return `❌ block_id "${blockId}" 格式无效，请提供正确的 UUID。`;

    const comments = await getBlockComments(productionId, blockId);
    if (comments.length === 0) return `Block ${blockId} 暂无评论。`;

    const lines = [
      `Block ${blockId} 共 ${comments.length} 条评论：`,
      "",
      ...comments.map(formatComment),
    ];
    return lines.join("\n");
  },
};
