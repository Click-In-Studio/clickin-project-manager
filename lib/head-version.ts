import { getActiveVersionId } from "@/lib/db";

/**
 * 线性化不变量（版本退役 Phase B）：写操作只允许落在当前活跃版本（head）上。
 * 历史版本一律只读——这是未来「历史记录 / checkpoint」概念的地基。
 *
 * 调用方显式指定了非 head 版本时返回 409 Response；未指定或指定的就是 head
 * 时返回 null 放行。读路由不受此限制（查看历史仍合法）。
 */
export async function rejectNonHeadWrite(
  productionId: string,
  requestedVersionId?: string | null,
): Promise<Response | null> {
  if (!requestedVersionId) return null;
  const active = await getActiveVersionId(productionId);
  if (requestedVersionId === active) return null;
  return Response.json({ error: "历史版本只读，仅可编辑当前版本" }, { status: 409 });
}
