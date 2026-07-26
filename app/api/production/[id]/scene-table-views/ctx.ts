import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import type { PermissionContext } from "@/lib/permissions";

export async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, permCtx: null as PermissionContext | null, isArchived: false };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { session, permCtx: null as PermissionContext | null, isArchived: false };
  const { permCtx, isArchived } = access;
  return { session, permCtx, isArchived };
}
