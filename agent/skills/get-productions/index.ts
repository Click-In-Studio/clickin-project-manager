import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { getChatMemberOpenIds } from "../../feishu";
import { getProductionsVisibleToAll, getMemberRolesInProductions } from "../../db";
import type { ProductionInfo } from "../../db";
import { config } from "./config";

export const getProductionsSkill: SkillModule = {
  config,
  async run(ctx: BotContext): Promise<string> {
    const isGroup = ctx.trigger.chatType === "group";

    let openIds: string[];
    let hasMoreMembers = false;

    if (isGroup) {
      const result = await getChatMemberOpenIds(ctx.trigger.chatId);
      openIds = result.openIds;
      hasMoreMembers = result.hasMore;
      // Always include the sender in case they aren't in the member list yet
      if (!openIds.includes(ctx.trigger.senderId)) openIds.push(ctx.trigger.senderId);
    } else {
      openIds = [ctx.trigger.senderId];
    }

    const productions = await getProductionsVisibleToAll(openIds);

    if (productions.length === 0) {
      const note = isGroup ? "（基于当前群组成员权限交集）" : "";
      return `未找到可见的 production${note}。`;
    }

    const roleMap = await getMemberRolesInProductions(
      ctx.trigger.senderId,
      productions.map(p => p.id),
    );

    const lines: string[] = [];

    if (isGroup) {
      const memberNote = hasMoreMembers
        ? `（群成员 >100 人，仅取前 100 人的权限交集）`
        : `（基于当前群组 ${openIds.length} 名成员的权限交集）`;
      lines.push(memberNote);
    }

    lines.push(`共 ${productions.length} 个可见 production：\n`);

    productions.forEach((p, i) => {
      const roles = roleMap.get(p.id) ?? [];
      const roleStr = roles.length > 0 ? roles.join("、") : "（非成员/超管）";
      const date = p.createdAt.toISOString().slice(0, 10);
      lines.push(
        `${i + 1}. 《${p.name}》`,
        `   ID: ${p.id}`,
        `   成员总数：${p.memberCount} 人 | 创建于：${date}`,
        `   ${ctx.trigger.senderName} 的角色：${roleStr}`,
      );
    });

    return lines.join("\n");
  },
};
