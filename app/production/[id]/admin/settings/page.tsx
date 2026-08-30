import type { Metadata } from "next";
import { hasGrant } from "@/lib/grant-check";
export const metadata: Metadata = { title: "项目信息" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { getProductionPermissionContext, getProductionMeta } from "@/lib/db";
import { getSession } from "@/lib/session";
import { cookies } from "next/headers";
import AdminSettingsClient from "@/components/AdminSettingsClient";
import ProductionPlanCard from "@/components/ProductionPlanCard";
import { getProductionPlan, PRODUCTION_TIERS } from "@/lib/plan";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const [meta, access, plan] = await Promise.all([
    getProductionMeta(id),
    session
      ? getProductionPermissionContext(session.userId, session.isAdmin, id)
      : Promise.resolve(null),
    getProductionPlan(id),
  ]);

  const permCtx = access?.permCtx ?? null;
  const isArchived = access?.isArchived ?? false;

  const perms = {
    canRename: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/name", "edit")),
    canChangeAvatar: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/avatar", "edit")),
    canEditDescription: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/description", "edit")),
    canChangeType: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/type", "edit")),
    canChangeLanguage: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/language", "edit")),
    canArchive: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "archival", "create")),
    canDelete: !!permCtx && (permCtx.isAdmin || permCtx.isOwner),
    canImportScript: !!permCtx && (permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, id, "script", "*", "imports", "create")),
    canImportScenes: !!permCtx && (permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, id, "dramaturgy", "*", "imports", "create")),
    canManageTags: !!permCtx && (permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, id, "member", "*", "roles", "edit")),
    canToggleWatermark: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "config", "edit")),
    // 制作级 agents.md：制作人经模版 node:*/*@* 类型通配持有区间（激活成行
    // 后 hasGrant 命中），POC 部门区间无此键——「默认仅制作人」由此天然成立。
    canEditAiInstructions: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "ai_instructions", "*", "*", "edit")),
    // AI 用量可见性（#383）：默认只有 owner 命中（第 1 步旁路），其余人要 owner
    // 在权限中心显式发 node:ai/*/usage@view。两枚键正交——总览与成员分解分开判。
    canSeeAiUsage: !!permCtx && (permCtx.isOwner || permCtx.isAdmin || await hasGrant(permCtx.userId, id, "ai", "*", "usage", "view")),
    canSeeAiUsageMembers: !!permCtx && (permCtx.isOwner || permCtx.isAdmin || await hasGrant(permCtx.userId, id, "ai", "*", "usage/members", "view")),
  };

  const tierConf = PRODUCTION_TIERS[plan.tier];
  return (
    <>
      <AdminSettingsClient
        productionId={id}
        initialMeta={meta ?? { name: "", description: "", avatarUrl: null, type: null, typeLabel: null, language: null, watermarkEnabled: false }}
        isArchived={isArchived}
        perms={perms}
        // 档位（付费维度）与 perms（权限维度）分开传：AI 未开通的项目里，制作级
        // agents.md 这一节整块不出现——为一个用不了的功能留配置面没有意义。
        planAi={tierConf.ai}
      />
      <ProductionPlanCard
        productionId={id}
        isOwner={!!permCtx?.isOwner}
        initial={{
          tier: plan.tier,
          label: tierConf.label,
          billingExempt: plan.billingExempt,
          seatLimit: tierConf.seatLimit,
          ai: tierConf.ai,
          advancedPerms: tierConf.advancedPerms,
        }}
      />
    </>
  );
}
