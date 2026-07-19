import type { SkillModule } from "../_types";
import type { BotContext } from "../../types";
import { config } from "./config";
import { getMyTechReqs, type MyTechReqEntry } from "../../db-events";

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
  awaiting: "待确认",
  done: "已完成",
  cancelled: "已取消",
};

const ROLE_LABEL: Record<string, string> = {
  assignee: "负责人",
  poc: "部门POC",
};

function renderReq(req: MyTechReqEntry): string {
  const dept = req.departmentName ? `【${req.departmentName}】` : "";
  const status = STATUS_LABEL[req.status] ?? req.status;
  const role = ROLE_LABEL[req.role] ?? req.role;
  return `- ${dept}**${req.title}** [${status}]（${role}）\n  ${req.eventTitle} · ${req.productionName}`;
}

export const getMyTechReqsSkill: SkillModule<Record<string, never>> = {
  config,
  async run(ctx: BotContext): Promise<string> {
    const reqs = await getMyTechReqs(ctx.trigger.userId);

    if (!reqs.length) {
      return "✅ 当前没有待处理的技术需求。";
    }

    // Separate by role for clearer presentation
    const assigneeReqs = reqs.filter(r => r.role === "assignee");
    const pocReqs = reqs.filter(r => r.role === "poc");

    const lines: string[] = [`## 🔧 我的技术需求（共 ${reqs.length} 条）`, ""];

    if (assigneeReqs.length > 0) {
      lines.push(`### 我负责的需求（${assigneeReqs.length} 条）`);
      for (const req of assigneeReqs) lines.push(renderReq(req));
      lines.push("");
    }

    if (pocReqs.length > 0) {
      lines.push(`### 待我确认的需求（${pocReqs.length} 条）`);
      for (const req of pocReqs) lines.push(renderReq(req));
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  },
};
