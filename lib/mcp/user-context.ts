// MCP 用户信息层：
//   buildUserContextMarkdown  — 注入 system prompt 的"当前用户"档案（基础信息）
//   querySelfSensitive        — users.query_sensitive 工具（查询自己的
//                               联系方式，经确认门后到达）
//
// caller 身份一律来自 _caller_user_id —— 由 clickin-memory 插件在
// before_tool_call 里按 sessionKey 强制覆写（模型无法伪造）。
//
// 刻意没有"查他人"工具：webchat sessionKey 尚无 production 维度，会话
// 不携带"当前剧组"语境，跨成员查询没有权限判定基础——等 production
// 环境落地（sessionKey 扩展 productionId）后再回来加成员查询。

import { getPool } from "@/lib/pg";
import { getUserProfile, listMyProductionsWithRoles } from "@/lib/db";
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

/** users.query_sensitive：查询**调用者自己**的联系方式与登录身份。
 * 敏感信息——即使目标是自己也走确认门（工具不标 readOnlyHint，插件
 * fail-closed 门控自动拦截弹卡）。 */
export async function querySelfSensitive(callerUserId: string): Promise<string> {
  // 数据源优先级：用户档案层（user_profile.phone / user_platform_identity
  // 的 primary email）优先，feishu_user 的同步值仅作回落——feishu_user 是
  // 飞书同步层（schema 注释明确），不是用户自己维护的档案正主。
  const res = await getPool().query<{ name: string; email: string | null; phone: string | null }>(
    `SELECT up.name,
            COALESCE(upi.platform_user_id, fu.email) AS email,
            COALESCE(up.phone, fu.phone) AS phone
     FROM user_profile up
     LEFT JOIN feishu_user fu ON fu.user_id = up.user_id
     LEFT JOIN user_platform_identity upi
       ON upi.user_id = up.user_id
      AND upi.platform_id = 'email'
      AND upi.is_primary = true
     WHERE up.user_id = $1`,
    [callerUserId],
  );
  if (!res.rows.length) return "没有找到你的用户档案。";
  const r = res.rows[0];
  return [
    `你的登记信息（${r.name}）：`,
    `- 邮箱：${r.email ?? "（未登记）"}`,
    `- 电话：${r.phone ?? "（未登记）"}`,
  ].join("\n");
}
