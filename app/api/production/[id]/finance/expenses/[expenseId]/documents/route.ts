import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import {
  addExpenseDocument, FinanceError, removeExpenseDocument, type ExpenseDocumentKind,
} from "@/lib/ops/finance-db";
import { deleteAsset } from "@/lib/asset/db";
import { deleteR2Object } from "@/lib/r2";
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
  const expectedMutationSeq = parsed.value.expectedMutationSeq;
  if (typeof assetFileId !== "string"
      || (kind !== "invoice" && kind !== "receipt" && kind !== "other"))
    return Response.json({ error: "凭证类型或文件无效" }, { status: 400 });
  if (typeof expectedMutationSeq !== "number" || !Number.isSafeInteger(expectedMutationSeq) || expectedMutationSeq < 0)
    return Response.json({ error: "expectedMutationSeq 无效" }, { status: 400 });

  try {
    const expense = await addExpenseDocument({
      expenseId, productionId, submittedBy: session.userId,
      assetFileId, kind: kind as ExpenseDocumentKind, expectedMutationSeq,
    });
    return Response.json({ expense }, { status: 201 });
  } catch (error) {
    if (error instanceof FinanceError) {
      const status = error.reason === "stale" || error.reason === "invalid_state" ? 409 : 403;
      return Response.json({ error: error.message }, { status });
    }
    throw error;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, expenseId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const assetFileId = parsed.value.assetFileId;
  const expectedMutationSeq = parsed.value.expectedMutationSeq;
  if (typeof assetFileId !== "string" || typeof expectedMutationSeq !== "number" || !Number.isSafeInteger(expectedMutationSeq)
      || expectedMutationSeq < 0)
    return Response.json({ error: "凭证或 expectedMutationSeq 无效" }, { status: 400 });
  try {
    const result = await removeExpenseDocument({
      expenseId, productionId, submittedBy: session.userId,
      assetFileId, expectedMutationSeq,
    });
    // DB 关系已安全解除后沿用通用资产删除；R2 失败账本化由 #428 统一收口。
    const { r2Keys } = await deleteAsset(result.assetId);
    await Promise.allSettled(r2Keys.map(key => deleteR2Object(key)));
    return Response.json({ expense: result.expense });
  } catch (error) {
    if (error instanceof FinanceError) {
      const status = error.reason === "stale" || error.reason === "invalid_state" ? 409 : 403;
      return Response.json({ error: error.message }, { status });
    }
    throw error;
  }
}
