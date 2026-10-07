import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { canAccessNode } from "@/lib/perm/grant-template";
import { listProductionDepts } from "@/lib/perm/dept-db";
import { getProductionBaseCurrency, listBudgetCategories, listExpenseCategories } from "@/lib/ops/finance-db";
import AdminFinanceClient from "@/components/admin/AdminFinanceClient";
import PageActivationGate from "@/components/perm/PageActivationGate";

export const metadata: Metadata = { title: "财务设置" };

export default async function AdminFinancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(await cookies());
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  const actor = toActor(session, access.permCtx);
  const [categoryEntry, budgetEntry] = await Promise.all([
    canAccessNode(actor, id, "finance", "*", "categories", "edit"),
    canAccessNode(actor, id, "finance", "*", "budget", "edit"),
  ]);
  const categoryEligible = categoryEntry.allowed || categoryEntry.reason === "needs_self_confirm";
  const budgetEligible = budgetEntry.allowed || budgetEntry.reason === "needs_self_confirm";
  if (!categoryEligible && !budgetEligible) redirect(`/unauthorized?id=${id}`);
  const [baseCurrency, categories, items, depts, categoryEdit, categoryCreate, categoryDelete, budgetEdit, budgetCreate, budgetDelete] = await Promise.all([
    getProductionBaseCurrency(id), listExpenseCategories(id), listBudgetCategories(id), listProductionDepts(id),
    hasEffectiveGrant(actor, id, "finance", "*", "categories", "edit"),
    hasEffectiveGrant(actor, id, "finance", "*", "categories", "create"),
    hasEffectiveGrant(actor, id, "finance", "*", "categories", "delete"),
    hasEffectiveGrant(actor, id, "finance", "*", "budget", "edit"),
    hasEffectiveGrant(actor, id, "finance", "*", "budget", "create"),
    hasEffectiveGrant(actor, id, "finance", "*", "budget", "delete"),
  ]);
  return <>
    <AdminFinanceClient productionId={id} initialCategories={categories}
      baseCurrency={baseCurrency} initialItems={items} depts={depts.filter(d => d.kind === "dept").map(d => ({ id: d.id, name: d.name }))}
      caps={{ categoryEdit, categoryCreate, categoryDelete, budgetEdit, budgetCreate, budgetDelete }} />
    <PageActivationGate productionId={id} scope="finance" />
  </>;
}
