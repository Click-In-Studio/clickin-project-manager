import { NextResponse, type NextRequest } from "next/server";
import { requireUser, requireOwnership } from "@/lib/agent/chat/http";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { requireProductionFeature } from "@/lib/account/plan";
import { rootSessionIdentity } from "./session-runtime-db";

/** 子任务不签发新权限，所有查看/停止入口都校验主会话所有权与当前制作成员资格。 */
export async function requireSubagentParent(
  req: NextRequest,
  sessionKey: string | null,
) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  if (!sessionKey)
    return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;
  const row = await rootSessionIdentity(sessionKey);
  if (!row || row.user_id !== auth.userId)
    return NextResponse.json(
      { error: "会话不存在或无权访问" },
      { status: 403 },
    );
  if (row.production_id) {
    const member = await getProductionPermissionContext(
      auth.userId,
      false,
      row.production_id,
    );
    if (!member)
      return NextResponse.json(
        { error: "你不是该制作的成员" },
        { status: 403 },
      );
    const planDeny = await requireProductionFeature(row.production_id, "ai");
    if (planDeny) return planDeny;
  }
  return { sessionKey, userId: auth.userId, productionId: row.production_id };
}
