import type { BotContext, AgentResponse } from "../types";

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
  // sync  — executes and returns immediately; LLM freely chooses wait_reply.
  // async — may be slow (network query etc.); when wait_reply:true the runtime
  //         saves the session BEFORE executing so the user can interrupt,
  //         then auto-resumes when the result arrives.
  mode?: "sync" | "async";
  // Message sent to the user automatically while an async skill is executing.
  // The backend sends this before saving the session; the LLM should NOT reply itself.
  pendingMessage?: string;
  // Override / coerce fields in the LLM's JSON output before acting on it.
  // Return the response unchanged if no coercion is needed.
  constrain?: (response: AgentResponse) => AgentResponse;
};

// run() may return a string result that gets injected back into the LLM context.
// Skills that only perform side-effects return void.
export type SkillModule<TArgs = void> = {
  config: SkillConfig;
  run: TArgs extends void
    ? (ctx: BotContext) => Promise<string | void>
    : (ctx: BotContext, args: TArgs) => Promise<string | void>;
};
