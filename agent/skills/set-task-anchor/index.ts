import type { SkillModule } from "../_types";
import type { BotContext, TaskAnchor } from "../../types";
import { config } from "./config";
import { setTaskAnchor, clearTaskAnchor } from "../../db";

type SetTaskAnchorArgs = {
  action: "set" | "clear";
  type?: string;
  subject?: string;
  goal?: string;
  status?: string;
  confidence?: number;
};

export const setTaskAnchorSkill: SkillModule<SetTaskAnchorArgs> = {
  config,
  async run(ctx: BotContext, args: SetTaskAnchorArgs): Promise<string> {
    if (args.action === "clear") {
      await clearTaskAnchor(ctx.trigger.chatId);
      ctx.taskAnchor = undefined;
      return "任务锚点已清除。";
    }

    if (args.action === "set") {
      if (!args.type || !args.subject || !args.goal || !args.status || args.confidence === undefined) {
        return "❌ action=set 时必须同时提供 type、subject、goal、status 和 confidence。";
      }
      const anchor: TaskAnchor = {
        type:       args.type       as TaskAnchor["type"],
        subject:    args.subject,
        goal:       args.goal,
        status:     args.status     as TaskAnchor["status"],
        confidence: args.confidence,
      };
      await setTaskAnchor(ctx.trigger.chatId, anchor);
      ctx.taskAnchor = anchor;
      return `任务锚点已设置：${anchor.subject}（类型：${anchor.type}，置信度 ${anchor.confidence}）。`;
    }

    return `❌ 未知 action：${String(args.action)}`;
  },
};
