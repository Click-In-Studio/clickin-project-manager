import { getActiveVersionId, getVersion } from "@/lib/db";

/**
 * 线性化不变量（版本退役 Phase B）：写操作只允许落在当前活跃版本（head）上。
 * 历史版本一律只读——这是未来「历史记录 / checkpoint」概念的地基。
 *
 * 未指定或指定的就是 head 时返回 null 放行；指定了本演出的历史版本返回 409；
 * 指定了不存在 / 不属于本演出的版本返回 404——守卫自带归属判定，调用方
 * 无论把它放在自己的归属校验之前还是之后，错误语义都一致。
 * 读路由不受此限制（查看历史仍合法）。
 */
export async function rejectNonHeadWrite(
  productionId: string,
  requestedVersionId?: string | null,
): Promise<Response | null> {
  if (!requestedVersionId) return null;
  const active = await getActiveVersionId(productionId);
  if (requestedVersionId === active) return null;
  const version = await getVersion(requestedVersionId);
  if (!version || version.productionId !== productionId) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  return Response.json({ error: "历史版本只读，仅可编辑当前版本" }, { status: 409 });
}
