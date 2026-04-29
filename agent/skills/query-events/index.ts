import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { config } from "./config";
import { queryEvents, type EventFilters } from "../../db-events";
import { sendMessage } from "../../feishu";

type QueryEventsArgs = {
  filters: EventFilters;
};

function formatDate(d: Date | null): string {
  if (!d) return "未定";
  return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    .replace(/\//g, "-");
}

function formatStatus(s: string): string {
  const map: Record<string, string> = {
    draft: "草稿", active: "进行中", completed: "已完成", cancelled: "已取消",
  };
  return map[s] ?? s;
}

export const queryEventsSkill: SkillModule<QueryEventsArgs> = {
  config,
  async run(ctx: BotContext, args: QueryEventsArgs): Promise<string> {
    const productionId = ctx.productionContext?.productionId;
    if (!productionId) {
      return "❌ 未设置当前 production，请先通过 focus_production 确认要操作的 production。";
    }

    const receiveId     = ctx.trigger.chatType === "p2p" ? ctx.trigger.senderId : ctx.trigger.chatId;
    const receiveIdType = ctx.trigger.chatType === "p2p" ? "open_id" : "chat_id";
    await sendMessage(receiveId, receiveIdType, "text", JSON.stringify({ text: "🔍 正在查询事件列表..." }));

    const filters: EventFilters = args?.filters ?? {};
    const events = await queryEvents(productionId, filters);

    if (events.length === 0) {
      return "当前 production 下没有符合条件的事件。";
    }

    const lines: string[] = [
      `共找到 ${events.length} 个事件（最多显示 50 条）：`,
      "",
    ];

    for (const ev of events) {
      const managers = ev.stageManagers.length > 0
        ? ev.stageManagers.join("、")
        : "—";
      lines.push(
        `**${ev.title}**（${ev.eventType}）`,
        `  ID: ${ev.id}`,
        `  状态: ${formatStatus(ev.status)}  |  地点: ${ev.location || "—"}`,
        `  时间: ${formatDate(ev.startTime)} → ${formatDate(ev.endTime)}`,
        `  舞台监督: ${managers}`,
        ev.description ? `  备注: ${ev.description}` : "",
        "",
      );
    }

    // Contextual hint to encourage get_event_detail when details may be needed
    lines.push("");
    if (events.length === 1) {
      lines.push(`💡 提示：如需查看「${events[0].title}」的完整详情（流程单、集合时间、技术需求、报告），请调用 get_event_detail，event_id = ${events[0].id}`);
    } else if (events.length <= 5) {
      lines.push("💡 提示：以上为事件摘要。如需某个事件的完整详情（流程单、集合时间、技术需求、报告），请调用 get_event_detail 并提供对应 ID。");
    } else {
      lines.push("💡 提示：结果较多，如需某个事件的完整详情请调用 get_event_detail；如需缩小范围可追加过滤条件重新查询。");
    }

    return lines.filter(l => l !== undefined).join("\n").trimEnd();
  },
};
