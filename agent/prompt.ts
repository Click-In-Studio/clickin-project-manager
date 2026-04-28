import type { Message } from "./llm";

export type PromptVars = Record<string, string | number | boolean>;

export type PromptMessage = {
  role: Message["role"];
  template: string;
};

/**
 * Replace {{variable}} placeholders with values from vars.
 * Unresolved placeholders are left as-is and logged — makes bugs visible.
 */
export function render(template: string, vars: PromptVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key in vars) return String(vars[key]);
    console.warn(`[prompt] unresolved variable: {{${key}}}`);
    return match;
  });
}

/** Render a list of PromptMessages into a ready-to-send Message array. */
export function buildMessages(templates: PromptMessage[], vars: PromptVars): Message[] {
  return templates.map(t => ({ role: t.role, content: render(t.template, vars) }));
}
