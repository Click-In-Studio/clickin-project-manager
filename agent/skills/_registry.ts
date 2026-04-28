import { replySkill } from "./reply/index";
import { sendCardSkill } from "./send-card/index";
import { viewCardSkill } from "./view-card/index";
import type { BotContext } from "../types";
import type { SkillConfig, SkillParamDef } from "./_types";

export { replySkill, sendCardSkill, viewCardSkill };

type AnySkill = {
  config: SkillConfig;
  run: (ctx: BotContext, args: unknown) => Promise<string | void>;
};

export const skillRegistry: Record<string, AnySkill> = {
  reply:     replySkill    as unknown as AnySkill,
  send_card: sendCardSkill as unknown as AnySkill,
  view_card: viewCardSkill as unknown as AnySkill,
};

export function buildSkillsPrompt(): string {
  return Object.values(skillRegistry)
    .filter(s => s.config.enabled !== false)
    .map(s => {
      const modeTag = s.config.mode === "async" ? " [异步]" : "";
      const paramLines = s.config.params.map((p: SkillParamDef) =>
        `  - ${p.name} (${p.type}${p.required ? ", 必填" : ""}): ${p.description}`,
      ).join("\n");
      return `### ${s.config.name}${modeTag}\n${s.config.description}\n参数：\n${paramLines}`;
    })
    .join("\n\n");
}

export async function dispatchSkill(
  ctx: BotContext,
  skillName: string,
  args: unknown,
): Promise<string | undefined> {
  const skill = skillRegistry[skillName];
  if (!skill) throw new Error(`Unknown skill: ${skillName}`);
  if (skill.config.enabled === false) throw new Error(`Skill disabled: ${skillName}`);
  const result = await skill.run(ctx, args);
  return typeof result === "string" ? result : undefined;
}
