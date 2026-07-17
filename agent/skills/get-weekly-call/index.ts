import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { config } from "./config";
import { getWeeklyCallForUser, type UserCallEntry } from "../../db-events";

function fmtDate(d: Date): string {
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    month: "2-digit", day: "2-digit",
  }).replace(/\//g, "-");
}

function fmtCallAt(d: Date): string {
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtTime(d: Date): string {
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    hour: "2-digit", minute: "2-digit",
  });
}

function cstDateKey(d: Date): string {
  // Returns YYYY-MM-DD in CST
  const cst = new Date(d.getTime() + 8 * 3_600_000);
  return `${cst.getUTCFullYear()}-${String(cst.getUTCMonth() + 1).padStart(2, "0")}-${String(cst.getUTCDate()).padStart(2, "0")}`;
}

function renderEntry(entry: UserCallEntry): string[] {
  const lines: string[] = [];
  const loc = entry.eventLocation ? `  @ ${entry.eventLocation}` : "";
  lines.push(`  **${fmtCallAt(entry.callAt)}**  ${entry.eventTitle}（${entry.productionName}）${loc}`);
  if (entry.callNotes) lines.push(`    备注: ${entry.callNotes}`);
  if (entry.scheduleItems.length > 0) {
    const items = entry.scheduleItems
      .map(si => si.startTime ? `${fmtTime(si.startTime)} ${si.title}` : si.title)
      .join(" / ");
    lines.push(`    流程: ${items}`);
  }
  return lines;
}

export const getWeeklyCallSkill: SkillModule<Record<string, never>> = {
  config,
  async run(ctx: BotContext): Promise<string> {
    const openId = ctx.trigger.senderId;
    const entries = await getWeeklyCallForUser(openId);

    if (!entries.length) {
      return "📅 未来 7 天没有集合时间安排。";
    }

    // Group by CST date
    const byDate = new Map<string, UserCallEntry[]>();
    for (const entry of entries) {
      const key = cstDateKey(entry.callAt);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(entry);
    }

    const lines: string[] = ["## 📅 本周集合时间", ""];
    for (const [date, dayEntries] of byDate) {
      const firstDate = dayEntries[0].callAt;
      lines.push(`### ${date}（${fmtDate(firstDate)}）`);
      for (const entry of dayEntries) {
        lines.push(...renderEntry(entry));
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  },
};
