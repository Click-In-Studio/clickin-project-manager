import type { Metadata } from "next";
export const metadata: Metadata = { title: "策略中心" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { listPolicies, listPolicyAudit } from "@/lib/policy-db";
import { POLICY_QUESTIONS, matchAnswer, QUESTION_COVERED_KEYS } from "@/lib/policy-questions";
import AdminPoliciesClient from "@/components/AdminPoliciesClient";

export default async function PoliciesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;

  // 门与 API 同源：整个配置中心一个治理面门，键表内零 SENSITIVE。
  // SENSITIVE 是给「权限的权限」用的，判据是「改的是不是权限系统本身」而不是
  // 「后果严不严重」；策略键按定义都是产品能力开关。
  const canEdit = permCtx.isAdmin || permCtx.isOwner
    || await hasGrant(permCtx.userId, id, "production", "*", "config", "edit");

  const [name, policies, audit] = await Promise.all([
    getProductionName(id),
    listPolicies(id),          // 顺带自愈补齐缺行（新加的键、本表上线前的演出）
    listPolicyAudit(id, 20),
  ]);

  // 语义层与键表是**同一份数据的两个视图**，不是两张表（§6.4 纪律 1）。
  const current = new Map(policies.map((p) => [p.key, p.value]));
  const questions = POLICY_QUESTIONS.map((q) => ({
    id: q.id, group: q.group, title: q.title, help: q.help ?? null,
    danger: q.danger ?? false,
    answers: q.answers.map((a) => ({
      id: a.id, label: a.label, values: a.values, disposition: [...a.disposition],
    })),
    answerId: matchAnswer(q, current)?.id ?? null,
  }));

  return (
    <AdminPoliciesClient
      productionId={id}
      productionName={name ?? ""}
      initialPolicies={policies}
      initialQuestions={questions}
      advancedOnly={policies.filter((p) => !QUESTION_COVERED_KEYS.has(p.key)).map((p) => p.key)}
      initialAudit={audit}
      canEdit={canEdit}
    />
  );
}
