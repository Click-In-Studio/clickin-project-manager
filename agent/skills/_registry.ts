import { replySkill } from "./reply/index";
import { sendCardSkill } from "./send-card/index";
import { viewCardSkill } from "./view-card/index";
import { getHistorySkill } from "./get-history/index";
import { getChatInfoSkill } from "./get-chat-info/index";
import { getProductionsSkill } from "./get-productions/index";
import { focusProductionSkill } from "./focus-production/index";
import { queryEventsSkill } from "./query-events/index";
import { getEventDetailSkill } from "./get-event-detail/index";
import { listSkillsSkill, setSecondaryPrompt } from "./list-skills/index";
import type { BotContext } from "../types";
import type { SkillConfig, SkillParamDef } from "./_types";

export { replySkill, sendCardSkill, viewCardSkill, getHistorySkill, getChatInfoSkill, listSkillsSkill };

type AnySkill = {
  config: SkillConfig;
  run: (ctx: BotContext, args: unknown) => Promise<string | void>;
};

// Primary: always listed in the base prompt
const primarySkills: AnySkill[] = [
  replySkill            as unknown as AnySkill,
  sendCardSkill         as unknown as AnySkill,
  focusProductionSkill  as unknown as AnySkill,
  listSkillsSkill       as unknown as AnySkill,
];

// Secondary: hidden by default, returned by list_skills on demand
const secondarySkills: AnySkill[] = [
  viewCardSkill        as unknown as AnySkill,
  getHistorySkill      as unknown as AnySkill,
  getChatInfoSkill     as unknown as AnySkill,
  getProductionsSkill  as unknown as AnySkill,
  queryEventsSkill     as unknown as AnySkill,
  getEventDetailSkill  as unknown as AnySkill,
];

export const skillRegistry: Record<string, AnySkill> = {
  reply:          replySkill       as unknown as AnySkill,
  send_card:      sendCardSkill    as unknown as AnySkill,
  view_card:      viewCardSkill    as unknown as AnySkill,
  get_history:    getHistorySkill  as unknown as AnySkill,
  get_chat_info:     getChatInfoSkill    as unknown as AnySkill,
  get_productions:   getProductionsSkill as unknown as AnySkill,
  focus_production:  focusProductionSkill  as unknown as AnySkill,
  list_skills:       listSkillsSkill       as unknown as AnySkill,
  query_events:      queryEventsSkill      as unknown as AnySkill,
  get_event_detail:  getEventDetailSkill   as unknown as AnySkill,
};

function formatSkill(s: AnySkill): string {
  const modeTag = s.config.mode === "async" ? " [异步]" : "";
  const paramLines = s.config.params.length > 0
    ? s.config.params.map((p: SkillParamDef) =>
        `  - ${p.name} (${p.type}${p.required ? ", 必填" : ""}): ${p.description}`,
      ).join("\n")
    : "  （无）";
  return `### ${s.config.name}${modeTag}\n${s.config.description}\n参数：\n${paramLines}`;
}

export function buildSkillsPrompt(): string {
  return primarySkills
    .filter(s => s.config.enabled !== false)
    .map(formatSkill)
    .join("\n\n");
}

// Inject secondary skills description into list_skills at module load time
setSecondaryPrompt(
  secondarySkills
    .filter(s => s.config.enabled !== false)
    .map(formatSkill)
    .join("\n\n"),
);

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
