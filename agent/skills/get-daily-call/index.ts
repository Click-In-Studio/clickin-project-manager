import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { config } from "./config";
import { getDailyCallForUser, type UserCallEntry } from "../../db-events";

type GetDailyCallArgs = {
  date?: string;
};

function fmtCallAt(d: Date): string {
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).replace(/\//g, "-");
}

function fmtTime(d: Date): string {
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    hour: "2-digit", minute: "2-digit",
  });
}

function renderEntry(entry: UserCallEntry): string[] {
  const lines: string[] = [];
  const time = fmtCallAt(entry.callAt);
  const loc = entry.eventLocation ? `  @ ${entry.eventLocation}` : "";
  lines.push(`**${time}**  ${entry.eventTitle}（${entry.productionName}）${loc}`);
  if (entry.callNotes) lines.push(`  备注: ${entry.callNotes}`);
  if (entry.scheduleItems.length > 0) {
    const items = entry.scheduleItems
      .map(si => si.startTime ? `${fmtTime(si.startTime)} ${si.title}` : si.title)
      .join(" / ");
    lines.push(`  流程: ${items}`);
  }
  return lines;
}

export const getDailyCallSkill: SkillModule<GetDailyCallArgs> = {
  config,
  async run(ctx: BotContext, args: GetDailyCallArgs): Promise<string> {
    const userId = ctx.trigger.userId;
    const date = args?.date?.trim();

    // Validate date format if provided
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return `❌ 日期格式无效："${date}"，请使用 YYYY-MM-DD 格式。`;
    }

    const entries = await getDailyCallForUser(userId, date);

    const dateLabel = date ?? (() => {
      const nowCst = new Date(Date.now() + 8 * 3_600_000);
      return `${nowCst.getUTCFullYear()}-${String(nowCst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowCst.getUTCDate()).padStart(2, "0")}`;
    })();

    if (!entries.length) {
      return `📅 ${dateLabel} 没有集合时间安排。`;
    }

    const lines: string[] = [`## 📅 ${dateLabel} 的集合时间`, ""];
    for (const entry of entries) {
      lines.push(...renderEntry(entry), "");
    }
    return lines.join("\n").trimEnd();
  },
};
