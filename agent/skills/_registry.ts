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
import { setTaskAnchorSkill } from "./set-task-anchor/index";
import { getDailyCallSkill } from "./get-daily-call/index";
import { getWeeklyCallSkill } from "./get-weekly-call/index";
import { getMyTechReqsSkill } from "./get-my-tech-reqs/index";
import { getBlockByIdSkill } from "./get-block-by-id/index";
import { getBlockByLineSkill } from "./get-block-by-line/index";
import { searchBlocksSkill } from "./search-blocks/index";
import { getScenesSkill } from "./get-scenes/index";
import { getCharactersSkill } from "./get-characters/index";
import { queryBlocksSkill } from "./query-blocks/index";
import { getScriptMetaSkill } from "./get-script-meta/index";
import { getBlockCommentsSkill } from "./get-block-comments/index";
import { getMyMentionsSkill } from "./get-my-mentions/index";
import type { BotContext } from "../types";
import type { SkillConfig, SkillParamDef } from "./_types";

export { replySkill, sendCardSkill, viewCardSkill, getHistorySkill, getChatInfoSkill, listSkillsSkill };

type AnySkill = {
  config: SkillConfig;
  run: (ctx: BotContext, args: unknown) => Promise<string | void>;
};

// Skills always available even when no task anchor is set
const anchorRestrictedSkills: AnySkill[] = [
  replySkill          as unknown as AnySkill,
  sendCardSkill       as unknown as AnySkill,
  setTaskAnchorSkill  as unknown as AnySkill,
];

// Primary: listed in the base prompt when a task anchor is active
const primarySkills: AnySkill[] = [
  replySkill            as unknown as AnySkill,
  sendCardSkill         as unknown as AnySkill,
  focusProductionSkill  as unknown as AnySkill,
  listSkillsSkill       as unknown as AnySkill,
  setTaskAnchorSkill    as unknown as AnySkill,
];

// Skill names always callable regardless of anchor state
export const ANCHOR_EXEMPT_SKILLS = new Set(["reply", "send_card", "set_task_anchor"]);

// Secondary: hidden by default, returned by list_skills on demand
const secondarySkills: AnySkill[] = [
  viewCardSkill          as unknown as AnySkill,
  getHistorySkill        as unknown as AnySkill,
  getChatInfoSkill       as unknown as AnySkill,
  getProductionsSkill    as unknown as AnySkill,
  queryEventsSkill       as unknown as AnySkill,
  getEventDetailSkill    as unknown as AnySkill,
  getDailyCallSkill      as unknown as AnySkill,
  getWeeklyCallSkill     as unknown as AnySkill,
  getMyTechReqsSkill     as unknown as AnySkill,
  getBlockByIdSkill      as unknown as AnySkill,
  getBlockByLineSkill    as unknown as AnySkill,
  searchBlocksSkill      as unknown as AnySkill,
  getScenesSkill         as unknown as AnySkill,
  getCharactersSkill     as unknown as AnySkill,
  queryBlocksSkill       as unknown as AnySkill,
  getScriptMetaSkill     as unknown as AnySkill,
  getBlockCommentsSkill  as unknown as AnySkill,
  getMyMentionsSkill     as unknown as AnySkill,
];

export const skillRegistry: Record<string, AnySkill> = {
  reply:             replySkill            as unknown as AnySkill,
  send_card:         sendCardSkill         as unknown as AnySkill,
  view_card:         viewCardSkill         as unknown as AnySkill,
  get_history:       getHistorySkill       as unknown as AnySkill,
  get_chat_info:     getChatInfoSkill      as unknown as AnySkill,
  get_productions:   getProductionsSkill   as unknown as AnySkill,
  focus_production:  focusProductionSkill  as unknown as AnySkill,
  list_skills:       listSkillsSkill       as unknown as AnySkill,
  query_events:      queryEventsSkill      as unknown as AnySkill,
  get_event_detail:  getEventDetailSkill   as unknown as AnySkill,
  set_task_anchor:   setTaskAnchorSkill    as unknown as AnySkill,
  get_daily_call:    getDailyCallSkill     as unknown as AnySkill,
  get_weekly_call:   getWeeklyCallSkill    as unknown as AnySkill,
  get_my_tech_reqs:  getMyTechReqsSkill   as unknown as AnySkill,
  get_block_by_id:   getBlockByIdSkill    as unknown as AnySkill,
  get_block_by_line: getBlockByLineSkill  as unknown as AnySkill,
  search_blocks:     searchBlocksSkill    as unknown as AnySkill,
  get_scenes:        getScenesSkill       as unknown as AnySkill,
  get_characters:    getCharactersSkill   as unknown as AnySkill,
  query_blocks:      queryBlocksSkill     as unknown as AnySkill,
  get_script_meta:    getScriptMetaSkill    as unknown as AnySkill,
  get_block_comments: getBlockCommentsSkill as unknown as AnySkill,
  get_my_mentions:    getMyMentionsSkill    as unknown as AnySkill,
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

export function buildSkillsPrompt(hasTaskAnchor: boolean): string {
  const skills = hasTaskAnchor ? primarySkills : anchorRestrictedSkills;
  return skills
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
