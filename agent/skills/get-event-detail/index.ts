import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { config } from "./config";
import { getEventDetail } from "../../db-events";
import { sendMessage } from "../../feishu";

type GetEventDetailArgs = {
  event_id: string;
};

function fmt(d: Date | null): string {
  if (!d) return "未定";
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).replace(/\//g, "-");
}

function fmtTime(d: Date): string {
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtStatus(s: string): string {
  const map: Record<string, string> = {
    draft: "草稿", active: "进行中", completed: "已完成", cancelled: "已取消",
    pending: "待处理", done: "已完成",
  };
  return map[s] ?? s;
}

export const getEventDetailSkill: SkillModule<GetEventDetailArgs> = {
  config,
  async run(ctx: BotContext, args: GetEventDetailArgs): Promise<string> {
    const productionId = ctx.productionContext?.productionId;
    if (!productionId) {
      return "❌ 未设置当前 production，请先通过 focus_production 确认要操作的 production。";
    }

    const eventId = args?.event_id?.trim();
    if (!eventId) return "❌ 缺少 event_id 参数。";
    // Basic UUID format check — catches hallucinated IDs like "1" before hitting DB
    if (!/^[0-9a-z_-]{8,}$/i.test(eventId)) {
      return `❌ event_id "${eventId}" 格式无效。请通过 query_events 获取真实的事件 ID 后再调用本技能。`;
    }

    const receiveId     = ctx.trigger.chatType === "p2p" ? ctx.trigger.senderId : ctx.trigger.chatId;
    const receiveIdType = ctx.trigger.chatType === "p2p" ? "open_id" : "chat_id";
    await sendMessage(receiveId, receiveIdType, "text", JSON.stringify({ text: "🔍 正在查询事件详情..." }));

    const ev = await getEventDetail(eventId, productionId);
    if (!ev) return "❌ 未找到该事件，或该事件不属于当前 production。";

    const lines: string[] = [];

    // Header
    lines.push(`# ${ev.title}（${ev.eventType}）`);
    lines.push(`状态: ${fmtStatus(ev.status)}  |  地点: ${ev.location || "—"}`);
    lines.push(`时间: ${fmt(ev.startTime)} → ${fmt(ev.endTime)}`);
    if (ev.description) lines.push(`备注: ${ev.description}`);
    if (ev.stageManagers.length > 0) {
      lines.push(`舞台监督: ${ev.stageManagers.map(m => m.name).join("、")}`);
    }

    // Schedule items
    if (ev.scheduleItems.length > 0) {
      lines.push("", "## 流程单");
      for (const item of ev.scheduleItems) {
        const scene = item.sceneName ? `（场景：${item.sceneName}）` : "";
        const pts = item.participants.length > 0 ? `  参与: ${item.participants.join("、")}` : "";
        lines.push(
          `- **${item.title}**${scene} [${item.itemType}]`,
          `  ${fmt(item.startTime)} → ${fmt(item.endTime)}  ${item.location ? "@ " + item.location : ""}`,
        );
        if (pts) lines.push(pts);
        if (item.notes) lines.push(`  备注: ${item.notes}`);
      }
    }

    // Participants
    if (ev.participants.length > 0) {
      lines.push("", "## 参与人员与集合时间");
      for (const p of ev.participants) {
        const dept = p.departmentName ? `（${p.departmentName}）` : "";
        lines.push(`**${p.name}**${dept} — ${p.role}`);
        if (p.callTimes.length > 0) {
          for (const ct of p.callTimes) {
            const item = ct.scheduleItemTitle ? ` / ${ct.scheduleItemTitle}` : "";
            const note = ct.notes ? `（${ct.notes}）` : "";
            lines.push(`  集合: ${fmt(ct.callAt)}${item}${note}`);
          }
        }
      }
    }

    // Call sheet
    if (ev.callSheet.length > 0) {
      lines.push("", "## 集合时间表");
      for (const ct of ev.callSheet) {
        const dept = ct.departmentName ? `【${ct.departmentName}】` : "";
        const item = ct.scheduleItemTitle ? ` → ${ct.scheduleItemTitle}` : "";
        const note = ct.notes ? `  备注: ${ct.notes}` : "";
        lines.push(`${fmtTime(ct.callAt)}  ${dept}${ct.name}${item}`);
        if (note) lines.push(note);
      }
    }

    // Tech requirements
    if (ev.techReqs.length > 0) {
      lines.push("", "## 技术需求");
      for (const req of ev.techReqs) {
        const dept = req.departmentName ? `【${req.departmentName}】` : "";
        const assignees = req.assignees.length > 0 ? `  负责人: ${req.assignees.join("、")}` : "";
        const items = req.scheduleItemTitles.length > 0
          ? `  关联流程: ${req.scheduleItemTitles.join("、")}` : "";
        const preset = req.presetMinutes != null ? `  提前 ${req.presetMinutes} 分钟` : "";
        lines.push(
          `- ${dept}**${req.title}** [${fmtStatus(req.status)}]${preset}`,
        );
        if (req.description) lines.push(`  ${req.description}`);
        if (assignees) lines.push(assignees);
        if (items) lines.push(items);
      }
    }

    // Reports
    if (ev.reports.length > 0) {
      lines.push("", "## 演出报告");
      for (const rep of ev.reports) {
        lines.push(`**${rep.title}**（${rep.reportType}）  发布: ${fmt(rep.publishedAt)}`);
        if (rep.body) lines.push(rep.body.slice(0, 300) + (rep.body.length > 300 ? "…" : ""));
        if (rep.notes.length > 0) {
          lines.push("  部门备注:");
          for (const n of rep.notes) {
            lines.push(`  - 【${n.departmentName}】${n.authorName}: ${n.content}`);
          }
        }
      }
    }

    return lines.join("\n");
  },
};
