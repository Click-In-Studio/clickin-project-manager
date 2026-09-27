import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import {
  addExpenseDocument, FinanceError, type ExpenseDocumentKind,
} from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; expenseId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, expenseId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const assetFileId = parsed.value.assetFileId;
  const kind = parsed.value.kind;
  if (typeof assetFileId !== "string"
      || (kind !== "invoice" && kind !== "receipt" && kind !== "other"))
    return Response.json({ error: "凭证类型或文件无效" }, { status: 400 });

  try {
    const expense = await addExpenseDocument({
      expenseId, productionId, submittedBy: session.userId,
      assetFileId, kind: kind as ExpenseDocumentKind,
    });
    return Response.json({ expense }, { status: 201 });
  } catch (error) {
    if (error instanceof FinanceError) {
      const status = error.reason === "not_pending" ? 409 : 403;
      return Response.json({ error: error.message }, { status });
    }
    throw error;
  }
}
