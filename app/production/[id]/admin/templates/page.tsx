import type { Metadata } from "next";
export const metadata: Metadata = { title: "权限模版" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { listProductionDepts } from "@/lib/dept-db";
import { listDeptCueTemplates, listCueTemplateTypes } from "@/lib/cue-template-db";
import AdminTemplatesClient from "@/components/AdminTemplatesClient";

export default async function TemplatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  const [canEdit, canViewOnly, canManageTypes] = await Promise.all([
    bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "grants", "edit"),
    bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "grants", "view"),
    bypass || hasGrant(permCtx.userId, id, "production", "*", "config", "edit"),
  ]);
  const canView = canEdit || canViewOnly || canManageTypes;
  if (!canView) redirect(`/production/${id}/admin`);

  const [name, depts, templates, types] = await Promise.all([
    getProductionName(id),
    listProductionDepts(id),
    listDeptCueTemplates(id),
    listCueTemplateTypes(id),
  ]);

  return (
    <AdminTemplatesClient
      productionId={id}
      productionName={name ?? ""}
      depts={depts.map(d => ({ id: d.id, name: d.name, kind: d.kind }))}
      initialRows={templates.map(t => ({
        deptId: t.deptId, template: t.template, canCreate: t.canCreate, permissions: t.permissions,
      }))}
      initialTypes={types.map(t => ({ id: t.id, key: t.key, abbrHint: t.abbrHint }))}
      canEdit={canEdit}
      canManageTypes={canManageTypes}
    />
  );
}
