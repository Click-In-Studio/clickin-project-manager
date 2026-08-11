// MCP 用户信息层：
//   buildUserContextMarkdown  — 注入 system prompt 的"当前用户"档案
//   queryUsers                — users.query 工具（基础信息，只读直通）
//   queryUserSensitive        — users.query_sensitive 工具（联系方式，确认门后）
//
// caller 身份一律来自 _caller_user_id —— 由 clickin-memory 插件在
// before_tool_call 里按 sessionKey 强制覆写（模型无法伪造），MCP server
// 只信这个字段。工具内部权限（Level C）：非管理员只能查与自己共享
// production 的成员。

import { getUserProfile, listMyProductionsWithRoles, listProductionMembersWithRoles } from "@/lib/db";
import { ADMIN_PANEL_PERMISSIONS } from "@/lib/permissions";

export async function buildUserContextMarkdown(userId: string): Promise<string | null> {
  const profile = await getUserProfile(userId);
  if (!profile) return null;
  const productions = await listMyProductionsWithRoles(userId, profile.isAdmin, [...ADMIN_PANEL_PERMISSIONS]);

  const lines: string[] = [
    `## 当前用户`,
    `- 姓名：${profile.name}${profile.displayName && profile.displayName !== profile.name ? `（显示名：${profile.displayName}）` : ""}`,
    `- 平台管理员：${profile.isAdmin ? "是" : "否"}`,
  ];
  if (profile.bio) lines.push(`- 简介：${profile.bio.slice(0, 200)}`);
  const active = productions.filter((p) => !p.archivedAt);
  if (active.length > 0) {
    lines.push(`- 参与制作：`);
    for (const p of active.slice(0, 12)) {
      const roles = p.roles?.length ? p.roles.join("、") : "成员";
      lines.push(`  - 《${p.name}》：${roles}${p.firstTag ? `（${p.firstTag}）` : ""}`);
    }
  }
  return lines.join("\n");
}

// 权限收窄的成员视图：调用者可见的全部成员（自己参与的 productions 的
// 并集；管理员 = 全部 productions）。同源查询，投影分级。
async function visibleMembers(callerUserId: string): Promise<
  Map<string, { name: string; status: string; email: string | null; phone: string | null; memberships: { production: string; roles: string[] }[] }>
> {
  const profile = await getUserProfile(callerUserId);
  if (!profile) return new Map();
  const productions = await listMyProductionsWithRoles(callerUserId, profile.isAdmin, [...ADMIN_PANEL_PERMISSIONS]);

  const byUser = new Map<string, { name: string; status: string; email: string | null; phone: string | null; memberships: { production: string; roles: string[] }[] }>();
  for (const p of productions) {
    if (p.archivedAt) continue;
    const members = await listProductionMembersWithRoles(p.id);
    for (const m of members) {
      const entry = byUser.get(m.userId) ?? {
        name: m.name,
        status: m.status,
        email: m.email,
        phone: m.phone,
        memberships: [],
      };
      entry.memberships.push({ production: p.name, roles: m.roles });
      byUser.set(m.userId, entry);
    }
  }
  return byUser;
}

/** users.query：按姓名模糊查基础信息（无联系方式）。 */
export async function queryUsers(callerUserId: string, query: string): Promise<string> {
  const members = await visibleMembers(callerUserId);
  const q = query.trim().toLowerCase();
  const hits = [...members.values()].filter((m) => m.name.toLowerCase().includes(q)).slice(0, 10);
  if (hits.length === 0) return `没有找到名字包含「${query}」的可见成员（可见范围：你参与的制作）。`;
  return hits
    .map((m) => {
      const roles = m.memberships.map((ms) => `《${ms.production}》${ms.roles.length ? `：${ms.roles.join("、")}` : ""}`).join("；");
      return `- ${m.name}${m.status === "suspended" ? "（已停用）" : ""} — ${roles}`;
    })
    .join("\n");
}

/** users.query_sensitive：查联系方式（email/电话）。经确认门后到达。 */
export async function queryUserSensitive(callerUserId: string, targetName: string): Promise<string> {
  const members = await visibleMembers(callerUserId);
  const q = targetName.trim().toLowerCase();
  const hits = [...members.values()].filter((m) => m.name.toLowerCase() === q);
  const fuzzy = hits.length > 0 ? hits : [...members.values()].filter((m) => m.name.toLowerCase().includes(q));
  if (fuzzy.length === 0) return `没有找到「${targetName}」（可见范围：你参与的制作的成员）。`;
  if (fuzzy.length > 3) return `「${targetName}」匹配到 ${fuzzy.length} 位成员，请提供更精确的姓名。`;
  return fuzzy
    .map((m) => `- ${m.name}：邮箱 ${m.email ?? "（未登记）"}，电话 ${m.phone ?? "（未登记）"}`)
    .join("\n");
}
