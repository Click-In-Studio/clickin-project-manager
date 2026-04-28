import { replySkill } from "./reply/index";
import { sendCardSkill } from "./send-card/index";
import type { BotContext } from "../types";
import type { SkillConfig, SkillParamDef } from "./_types";

export { replySkill, sendCardSkill };

type AnySkill = {
  config: SkillConfig;
  run: (ctx: BotContext, args: unknown) => Promise<void>;
};

export const skillRegistry: Record<string, AnySkill> = {
  reply:     replySkill     as unknown as AnySkill,
  send_card: sendCardSkill  as unknown as AnySkill,
};

export function buildSkillsPrompt(): string {
  return Object.values(skillRegistry)
    .filter(s => s.config.enabled !== false)
    .map(s => {
      const paramLines = s.config.params.map((p: SkillParamDef) =>
        `  - ${p.name} (${p.type}${p.required ? ", 必填" : ""}): ${p.description}`,
      ).join("\n");
      return `### ${s.config.name}\n${s.config.description}\n参数：\n${paramLines}`;
    })
    .join("\n\n");
}

export async function dispatchSkill(
  ctx: BotContext,
  skillName: string,
  args: unknown,
): Promise<void> {
  const skill = skillRegistry[skillName];
  if (!skill) throw new Error(`Unknown skill: ${skillName}`);
  if (skill.config.enabled === false) throw new Error(`Skill disabled: ${skillName}`);
  await skill.run(ctx, args);
}
