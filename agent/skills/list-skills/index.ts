import type { SkillModule } from "../_types";
import { config } from "./config";

// Injected by _registry.ts after all secondary skills are defined (avoids circular dep)
let _secondaryPrompt = "";
export function setSecondaryPrompt(prompt: string) { _secondaryPrompt = prompt; }

export const listSkillsSkill: SkillModule = {
  config,
  async run(): Promise<string> {
    return _secondaryPrompt || "（暂无扩展技能）";
  },
};
