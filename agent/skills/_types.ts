import type { BotContext } from "../types";

export type SkillParamDef = {
  name: string;
  type: string;
  description: string;
  required?: boolean;
};

export type SkillConfig = {
  name: string;
  description: string;
  enabled?: boolean;
  params: SkillParamDef[];
};

export type SkillModule<TArgs = void> = {
  config: SkillConfig;
  run: TArgs extends void
    ? (ctx: BotContext) => Promise<void>
    : (ctx: BotContext, args: TArgs) => Promise<void>;
};
