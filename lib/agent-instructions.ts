// agents.md 分级指令（制作级/个人级）——存取与注入组装。
// 设计见 MindWeave《Agents.md 分级注入设计》。
//
// 与记忆系统的分工：memory 是蒸馏管线自动产出的事实（仅参考），本表内容是
// 人手写的指令（须遵守）——注入时分属 <clickin-instructions> / <clickin-memory>
// 两个包裹，语义不可混。系统级不在这里：它是 gateway workspace 的 AGENTS.md
// （openclaw-workspace/ 版本控制 + CD 同步），位于 system prompt 最前，总优先
// 级秩序（系统 > 制作 > 个人）声明在它里面。
//
// 「语境不是权限」：指令没有任何权限语义，工具权限由 before_tool_call 身份
// 覆写 + 工具端判定独立把守，prompt 里写什么都不影响那条边界。

import { getPool } from "@/lib/pg";

export type InstructionScope = "user" | "production";

/**
 * 制作级指令的编辑权判定（REST 面与 MCP 工具共用）。权限节点
 * ai_instructions/*@edit：制作人经模版 node:*\/*@* 类型通配覆盖（区间→
 * 需自确认激活，与全站激活制一致），POC 的部门区间不含此键——「默认仅
 * 制作人、不给 POC」由此天然成立。isAdmin 取 DB profile 真值——
 * session.isAdmin 是恒 false 的死字段（#281）。
 */
export async function canEditProductionInstructions(userId: string, productionId: string): Promise<boolean> {
  // 动态 import 是刻意的：本模块被 MCP 注入链静态引用（inject.ts →
  // mcp/server.ts），lib/db / grant-template 的依赖树很重且有过 Turbopack
  // 循环依赖 TDZ 前科——权限判定只在编辑面/写工具触发，按需加载让注入
  // 链的静态依赖图保持最小（与 mcp/server.ts 的同一条纪律）。
  const { getProductionPermissionContext, getUserProfile } = await import("@/lib/db");
  const { canAccessNode } = await import("@/lib/grant-template");
  const profile = await getUserProfile(userId);
  if (!profile) return false;
  const access = await getProductionPermissionContext(userId, profile.isAdmin, productionId);
  if (!access) return false;
  const { permCtx } = access;
  const decision = await canAccessNode(
    { userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner },
    productionId,
    "ai_instructions",
    "*",
    "*",
    "edit",
  );
  return decision.allowed;
}

/** 存储上限（PUT 校验）——注入预算（INJECT_MAX_PER_SCOPE）比它小，超出部分
 * 注入时截断但存储保留，编辑面回显完整内容。 */
export const INSTRUCTIONS_MAX_LEN = 4000;

/** 每级注入预算（字符）。 */
const INJECT_MAX_PER_SCOPE = 2000;

export async function getAgentInstructions(scope: InstructionScope, scopeId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ content: string }>(
    `SELECT content FROM agent_instructions WHERE scope_type = $1 AND scope_id = $2`,
    [scope, scopeId],
  );
  const content = rows[0]?.content?.trim();
  return content || null;
}

export async function setAgentInstructions(
  scope: InstructionScope,
  scopeId: string,
  content: string,
  updatedBy: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO agent_instructions (scope_type, scope_id, content, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (scope_type, scope_id)
     DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [scope, scopeId, content, updatedBy],
  );
}

/** 注入用净化：标题防御性降级（#/##/### → ####，防与包裹块的 ### 段标题
 * 同级串段——与 memory 注入的降级同一思路）+ 预算截断。 */
function sanitizeForInject(content: string): string {
  const demoted = content.replace(/^#{1,3}(?=\s)/gm, "####");
  return demoted.length > INJECT_MAX_PER_SCOPE
    ? `${demoted.slice(0, INJECT_MAX_PER_SCOPE)}\n…（指令过长已截断）`
    : demoted;
}

/**
 * 组装注入的指令块正文（不含 <clickin-instructions> 包裹与声明语——那是
 * 插件侧的传输格式）。顺序从宽到窄：制作级在前、个人级在后；冲突裁决语义
 * （制作 > 个人）由包裹声明语承载。
 *
 * `includeProduction` 由调用方（buildInjectContext）传入——它绑定在「当前
 * 制作」段的实时成员校验结果上：非成员会话不注入制作级指令，与 production
 * 语境段同一道门，不重复查询。
 */
export async function buildInstructionsBlock(
  userId: string,
  productionId: string | null | undefined,
  includeProduction: boolean,
): Promise<string | null> {
  const wantProduction = includeProduction && !!productionId;
  const { rows } = await getPool().query<{ scope_type: InstructionScope; content: string }>(
    `SELECT scope_type, content FROM agent_instructions
     WHERE (scope_type = 'user' AND scope_id = $1)
        OR ($2::boolean AND scope_type = 'production' AND scope_id = $3)`,
    [userId, wantProduction, productionId ?? ""],
  );
  const byScope = new Map(rows.map((r) => [r.scope_type, r.content?.trim() ?? ""]));

  const sections: string[] = [];
  const production = byScope.get("production");
  if (production) sections.push(`### 本制作的指令\n${sanitizeForInject(production)}`);
  const personal = byScope.get("user");
  if (personal) sections.push(`### 用户的个人指令\n${sanitizeForInject(personal)}`);
  return sections.length > 0 ? sections.join("\n\n") : null;
}
