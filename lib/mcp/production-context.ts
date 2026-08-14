// "当前制作"注入段：production 会话的 system prompt 语境。
// 端点内做成员资格校验（签发时是成员 ≠ 现在还是成员），非成员返回 null
// 不注入。内容原则：语境不是权限——只描述"用户在这个制作里是什么身份"，
// 能查什么由工具内部权限判定，注入段不放权限清单。

import { getUserProfile, listMyProductionsWithRoles, listUpcomingMilestonesForUser } from "@/lib/db";
import { getProductionPermissionContext } from "@/lib/db";
import { listProductionDepts } from "@/lib/dept-db";
import { ADMIN_PANEL_NODE_PREFIXES } from "@/lib/permissions";
import { isoToDateInput } from "@/lib/tz";

export async function buildProductionContextMarkdown(userId: string, productionId: string): Promise<string | null> {
  const profile = await getUserProfile(userId);
  if (!profile) return null;

  // 成员资格实时校验（含管理员通道；非成员时函数本身返回 null 不抛）。
  // 真异常（DB 断连等）记日志后按"不注入"降级——注入是增强项不是关键
  // 路径，但错误不能无声消失成"像是非成员"。
  const access = await getProductionPermissionContext(userId, profile.isAdmin, productionId).catch((err) => {
    console.error(`[production-context] 成员资格查询异常（按不注入降级）user=${userId} prod=${productionId}:`, err);
    return null;
  });
  if (!access) return null;

  const productions = await listMyProductionsWithRoles(userId, profile.isAdmin, [...ADMIN_PANEL_NODE_PREFIXES]);
  const prod = productions.find((p) => p.id === productionId);
  if (!prod) return null;

  const lines: string[] = [
    `## 当前制作`,
    `- 《${prod.name}》${prod.archivedAt ? "（已归档）" : ""}`,
    `- 我的角色：${prod.roles?.length ? prod.roles.join("、") : "成员"}${prod.firstTag ? `（${prod.firstTag}）` : ""}${prod.isOwner ? "，所有者" : ""}`,
  ];

  try {
    const depts = await listProductionDepts(productionId);
    const mine = depts.filter((d) => d.memberUserIds.includes(userId));
    if (mine.length > 0) {
      lines.push(
        `- 我的部门：${mine.map((d) => `${d.name}${d.pocUserIds.includes(userId) ? "（负责人）" : ""}`).join("、")}`,
      );
    }
  } catch {
    // 部门信息缺失不阻塞注入
  }

  try {
    const milestones = (await listUpcomingMilestonesForUser(userId, profile.isAdmin))
      .filter((m) => m.productionId === productionId)
      .slice(0, 5);
    if (milestones.length > 0) {
      lines.push(`- 近期里程碑：`);
      for (const m of milestones) lines.push(`  - ${isoToDateInput(m.endDate)}｜${m.name}`);
    }
  } catch {
    // 里程碑缺失不阻塞注入
  }

  return lines.join("\n");
}
