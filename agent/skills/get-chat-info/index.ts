import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { getChatDetail } from "../../feishu";
import type { ChatDetailInfo } from "../../feishu";
import { config } from "./config";

function format(info: ChatDetailInfo, chatType: "p2p" | "group"): string {
  const lines: string[] = [];

  lines.push(`聊天名称：${info.name}`);

  if (chatType === "group") {
    lines.push(`成员总数：${info.memberCount} 人`);
    lines.push(`群主：${info.ownerName}`);

    if (info.adminNames.length > 0) {
      lines.push(`管理员：${info.adminNames.join("、")}`);
    } else {
      lines.push("管理员：（无或无权限获取）");
    }

    if (info.members.length > 0) {
      const memberLine = info.members
        .map(m => {
          if (m.openId === info.ownerId) return `${m.name}（群主）`;
          if (info.adminNames.includes(m.name)) return `${m.name}（管理员）`;
          return m.name;
        })
        .join("、");
      const suffix = info.hasMoreMembers ? `（仅显示前 ${info.members.length} 人）` : "";
      lines.push(`成员列表${suffix}：${memberLine}`);
    }
  } else {
    lines.push(`聊天类型：单聊`);
    if (info.members.length > 0) {
      lines.push(`成员：${info.members.map(m => m.name).join("、")}`);
    }
  }

  return lines.join("\n");
}

export const getChatInfoSkill: SkillModule = {
  config,
  async run(ctx: BotContext): Promise<string> {
    const info = await getChatDetail(ctx.trigger.chatId);
    return format(info, ctx.trigger.chatType);
  },
};
