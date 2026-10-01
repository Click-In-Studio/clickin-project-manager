import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { enqueueExpenseDocumentRecognition } from "@/lib/job/asset-jobs";
import { getFinancialDocumentAsset } from "@/lib/ops/finance-document-db";
import { expenseRecognitionVersions } from "@/lib/ops/expense-document-recognition";
import { getExpenseDocumentRecognition } from "@/lib/ops/expense-recognition-db";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

type CheckedContext =
  | { ok: false; response: Response }
  | {
      ok: true;
      productionId: string;
      assetId: string;
      session: NonNullable<ReturnType<typeof getSession>>;
      access: NonNullable<Awaited<ReturnType<typeof getProductionPermissionContext>>>;
      document: NonNullable<Awaited<ReturnType<typeof getFinancialDocumentAsset>>>;
    };

async function context(req: NextRequest, ctx: Ctx): Promise<CheckedContext> {
  const { id: productionId, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return { ok: false, response: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { ok: false, response: Response.json({ error: "无权访问" }, { status: 403 }) };
  const document = await getFinancialDocumentAsset(productionId, assetId);
  if (!document) return { ok: false, response: Response.json({ error: "凭证不存在" }, { status: 404 }) };
  const canViewAll = await hasEffectiveGrant(
    toActor(session, access.permCtx), productionId, "finance", "*", "expenses", "view",
  );
  const contextual = document.uploaderUserId === session.userId
    || document.linkedExpenses.some(expense => expense.submittedBy === session.userId
      || (expense.status === "pending" && expense.currentApproverIds.includes(session.userId)));
  if (!contextual && !(canViewAll && document.linkedExpenses.length > 0))
    return { ok: false, response: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { ok: true, productionId, assetId, session, access, document };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const checked = await context(req, ctx);
  if (!checked.ok) return checked.response;
  const recognition = await getExpenseDocumentRecognition(
    checked.document.assetFileId, expenseRecognitionVersions(),
  );
  return Response.json({ recognition });
}

/** 显式重试；只允许上传者/报销提交人，查看全项目不等于可以消耗识别额度。 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const checked = await context(req, ctx);
  if (!checked.ok) return checked.response;
  if (checked.access.isArchived)
    return Response.json({ error: "已归档的项目不可重新识别" }, { status: 403 });
  const ownsDocument = checked.document.uploaderUserId === checked.session.userId
    || checked.document.linkedExpenses.some(expense => expense.submittedBy === checked.session.userId);
  const canCreate = await hasEffectiveGrant(
    toActor(checked.session, checked.access.permCtx), checked.productionId,
    "finance", "*", "expenses", "create",
  );
  if (!ownsDocument || !canCreate)
    return Response.json({ error: "只能重新识别自己报销中的凭证" }, { status: 403 });
  try {
    await enqueueExpenseDocumentRecognition(checked.document.assetFileId, true);
  } catch {
    return Response.json({ error: "识别任务暂时无法启动，请稍后重试" }, { status: 503 });
  }
  const recognition = await getExpenseDocumentRecognition(
    checked.document.assetFileId, expenseRecognitionVersions(),
  );
  return Response.json({ recognition }, { status: 202 });
}
