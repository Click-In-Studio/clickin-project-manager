// production.* 项目工具层——与 my.* 个人工具的语义分界（用户定的原则）：
//
//   个人查询（my.*）      权限过滤内嵌在查询里，永不拒绝：零权限用户查到
//                         空结果；范围跨全部制作，不局限当前项目
//   项目查询（production.*）权限门在前：非成员/无权限 → 明确"权限被拒绝"，
//                         不是空结果；且仅在关联制作的会话中可用
//
// 本文件各工具的门 = 成员资格（项目详情按需求定义为成员内公开信息；
// 职位/通知天然 self-scoped；里程碑/通讯录/部门树成员可见）。未来需要更细
// 权限键的工具（tech reqs 等）在 requireMember 之上再叠 hasPermission。

import {
  getUserProfile,
  getProductionMeta,
  getProductionOwnerInfo,
  getProductionPermissionContext,
  listProductionMembers,
  listProductionMembersWithRoles,
  listMyProductionsWithRoles,
  listMilestones,
} from "@/lib/db";
import { listUserNotifications } from "@/lib/inbox-db";
import { listProductionDepts } from "@/lib/dept-db";
import { ADMIN_PANEL_NODE_PREFIXES } from "@/lib/permissions";
import { isoToDateInput, isoToDatetimeLocal } from "@/lib/tz";
import { toActor, type GrantActor } from "@/lib/grant-check";

export const DENIED_NOT_MEMBER = "权限被拒绝：你不是该制作的成员。";

/**
 * 项目工具统一前置门：成员资格。通过返回 null，拒绝返回给模型的文案。
 *
 * getProductionPermissionContext 内置 isAdmin/isOwner 旁路（与 production/[id] 等
 * 线上 API 同一份口径，非本工具新增）——平台管理员/项目所有者即使不是
 * production_member 行也会通过。这不是「成员资格」字面意义上的漏洞，而是
 * 全站统一的 admin/owner 旁路惯例；见 tests 里 non-member admin passes 用例锁定。
 */
async function memberGate(userId: string, productionId: string): Promise<string | null> {
  const profile = await getUserProfile(userId);
  if (!profile) return DENIED_NOT_MEMBER;
  const access = await getProductionPermissionContext(userId, profile.isAdmin, productionId);
  return access ? null : DENIED_NOT_MEMBER;
}

/**
 * 同一套 getUserProfile → getProductionPermissionContext 序列，但带出
 * GrantActor（isOwner）+ isArchived——供需要实例级权限判定（wiki 等，
 * lib/*-perm.ts 的 hasGrant/hasEffectiveGrant 系列）的 production.* 工具复用，
 * 而不是只有 memberGate 的 null/拒绝文案两态。
 */
export async function resolveProductionActor(
  userId: string, productionId: string,
): Promise<{ actor: GrantActor; isArchived: boolean } | null> {
  const profile = await getUserProfile(userId);
  if (!profile) return null;
  const access = await getProductionPermissionContext(userId, profile.isAdmin, productionId);
  if (!access) return null;
  return { actor: toActor({ userId }, access.permCtx), isArchived: access.isArchived };
}

/** production.info：项目详情（成员内公开信息，无需细分权限）。 */
export async function productionInfo(userId: string, productionId: string): Promise<string> {
  const denied = await memberGate(userId, productionId);
  if (denied) return denied;

  const meta = await getProductionMeta(productionId);
  if (!meta) return "没有找到该制作。";

  const ownerInfo = await getProductionOwnerInfo(productionId);
  const ownerId = ownerInfo?.ownerId ?? null;
  const archived = ownerInfo?.archived ?? false;
  const ownerName = ownerId ? (await getUserProfile(ownerId))?.name ?? null : null;

  const members = await listProductionMembersWithRoles(productionId);
  const producers = members.filter((m) => m.roles.includes("制作人")).map((m) => m.name);

  const lines = [
    `《${meta.name}》${archived ? "（已归档）" : ""}`,
    meta.typeLabel || meta.type ? `- 类型：${meta.typeLabel ?? meta.type}` : null,
    meta.language ? `- 语言：${meta.language}` : null,
    ownerName ? `- 所有者：${ownerName}` : null,
    producers.length > 0 ? `- 制作人：${producers.join("、")}` : null,
    meta.description ? `- 简介：${meta.description.slice(0, 500)}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

/** production.my_role：我在当前制作的职位与部门。 */
export async function productionMyRole(userId: string, productionId: string): Promise<string> {
  const denied = await memberGate(userId, productionId);
  if (denied) return denied;

  const profile = await getUserProfile(userId);
  const productions = await listMyProductionsWithRoles(userId, profile?.isAdmin ?? false, [...ADMIN_PANEL_NODE_PREFIXES]);
  const prod = productions.find((p) => p.id === productionId);
  if (!prod) return DENIED_NOT_MEMBER;

  const lines = [
    `- 职位：${prod.roles?.length ? prod.roles.join("、") : "成员"}${prod.isOwner ? "（所有者）" : ""}`,
  ];
  if (prod.firstTag) lines.push(`- 标签：${prod.firstTag}`);
  // 部门查询失败按「未分配」优雅降级而非抛错——职位工具的核心信息是 roles，
  // 部门只是补充；单次 DB 抖动不该让整个 my_role 查询失败。
  const depts = await listProductionDepts(productionId).catch(() => []);
  const mine = depts.filter((d) => d.memberUserIds.includes(userId));
  if (mine.length > 0) {
    lines.push(`- 部门：${mine.map((d) => `${d.name}${d.pocUserIds.includes(userId) ? "（负责人）" : ""}`).join("、")}`);
  } else {
    lines.push(`- 部门：（未分配）`);
  }
  return lines.join("\n");
}

/** production.notifications：我在当前制作的通知（收件箱天然 self-scoped）。 */
export async function productionNotifications(userId: string, productionId: string): Promise<string> {
  const denied = await memberGate(userId, productionId);
  if (denied) return denied;

  const rows = await listUserNotifications(userId, { productionId, limit: 15 });
  if (rows.length === 0) return "（当前制作没有你的通知）";
  return rows
    .map((n) => {
      const when = isoToDatetimeLocal(n.createdAt).replace("T", " ");
      const state = n.readAt ? "" : "【未读】";
      const cat = n.category === "warning" ? "⚠️ " : n.category === "action" ? "⏳ " : "";
      return `- ${when}｜${state}${cat}${n.title}${n.body ? `：${n.body.slice(0, 120)}` : ""}`;
    })
    .join("\n");
}

/**
 * production.contact_list：成员通讯录（id + 公开信息）。
 *
 * 门 = 成员资格，与 /api/production/[id]/contacts 同口径（该页对任意成员开放）。
 * 刻意**不含邮箱/电话**：联系方式是敏感面，全站只有 users.query_sensitive
 * 一条出口（查自己 + 确认门）——这里跟着 REST 把它们一并吐出来，等于给
 * 模型开了一条绕过确认门的通道。
 */
export async function productionContactList(userId: string, productionId: string): Promise<string> {
  const denied = await memberGate(userId, productionId);
  if (denied) return denied;

  const members = await listProductionMembersWithRoles(productionId);
  if (members.length === 0) return "（当前制作还没有成员）";

  // 部门查询失败按「未分配」优雅降级（同 productionMyRole）——通讯录的核心
  // 是人和 id，部门是补充信息，单次 DB 抖动不该让整张表查不出来。
  const depts = await listProductionDepts(productionId).catch(() => []);
  const deptLabels = new Map<string, string[]>();
  for (const d of depts) {
    for (const uid of d.memberUserIds) {
      const label = `${d.name}${d.pocUserIds.includes(uid) ? "（负责人）" : ""}`;
      deptLabels.set(uid, [...(deptLabels.get(uid) ?? []), label]);
    }
  }

  const CAP = 200;
  const lines = members.slice(0, CAP).map((m) => {
    const parts = [
      `- ${m.name || "（未命名）"}（id: ${m.userId}）`,
      `职位：${m.roles.length > 0 ? m.roles.join("、") : "成员"}`,
      `部门：${deptLabels.get(m.userId)?.join("、") ?? "（未分配）"}`,
    ];
    if (m.tags.length > 0) parts.push(`标签：${m.tags.join("、")}`);
    if (m.status === "suspended") parts.push("【已停用】");
    return parts.join("｜");
  });
  if (members.length > CAP) lines.push(`（共 ${members.length} 人，只列出前 ${CAP} 人）`);
  lines.unshift("（不含邮箱/电话——联系方式属敏感面，需本人经 users.query_sensitive 确认后才能读取）");
  return lines.join("\n");
}

/**
 * production.department_list：部门/用户组树（id + 名称 + 负责人）。
 *
 * 门 = 成员资格。/api/production/[id]/departments 的 GET 另叠了事件域 view，
 * 但那是给部门管理面用的；文档分享选人栏（wiki/[wikiId]/page.tsx）直接把整份
 * 部门列表发给任何能打开这篇文档的成员——本工具的用途正是喂 wiki_set_grant
 * 的 deptIds，取后者的口径。名称/id 是目录级信息，成员/负责人也在选人组件里公开。
 */
export async function productionDepartmentList(userId: string, productionId: string): Promise<string> {
  const denied = await memberGate(userId, productionId);
  if (denied) return denied;

  const depts = await listProductionDepts(productionId);
  if (depts.length === 0) return "（当前制作还没有部门）";

  const members = await listProductionMembers(productionId);
  const nameOf = new Map(members.map((m) => [m.userId, m.name || "（未命名）"]));

  // 孤儿节点（parent 指向已删/跨项目行）落到根层，不静默丢弃——同 wiki 树。
  const ids = new Set(depts.map((d) => d.id));
  const byParent = new Map<string | null, typeof depts>();
  for (const d of depts) {
    const key = d.parentId && ids.has(d.parentId) ? d.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), d]);
  }

  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const d of byParent.get(parentId) ?? []) {
      const pocs = d.pocUserIds.map((uid) => nameOf.get(uid) ?? uid);
      const parts = [
        `${"  ".repeat(depth)}- ${d.name}（id: ${d.id}）${d.kind === "group" ? "［用户组］" : ""}`,
        `负责人：${pocs.length > 0 ? pocs.join("、") : "（无）"}`,
        `成员 ${d.memberUserIds.length} 人`,
      ];
      lines.push(parts.join("｜"));
      walk(d.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

/** production.milestones：当前制作的全部里程碑（成员可见）。 */
export async function productionMilestones(userId: string, productionId: string): Promise<string> {
  const denied = await memberGate(userId, productionId);
  if (denied) return denied;

  const rows = await listMilestones(productionId);
  if (rows.length === 0) return "（当前制作还没有里程碑）";
  const today = new Date().toISOString().slice(0, 10);
  return rows
    .slice(0, 20)
    .map((m) => {
      const date = isoToDateInput(m.endDate);
      return `- ${date}｜${m.name}${date < today ? "（已过）" : ""}`;
    })
    .join("\n");
}
