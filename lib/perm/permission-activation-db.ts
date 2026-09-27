import { getProductionPermissionContext } from "./permission-context-db";
import { PAGE_PERMISSION_SCOPES } from "./page-permission-scopes";
import { parseNodeKey, selfConfirmTemplateNodes, type NodeKeyParts } from "./grant-template";

/** 页面与 AI 自确认共用的唯一目录；目录外的键即使格式合法也不能从激活入口落行。 */
export const ACTIVATABLE_NODE_KEYS: readonly string[] = [
  ...new Set(
    Object.values(PAGE_PERMISSION_SCOPES).flatMap((scope) =>
      [...scope].filter((key) => key.startsWith("node:")),
    ),
  ),
];

export type PermissionActivationResult =
  | { ok: true; confirmed: number }
  | { ok: false; status: 400 | 403; error: string };

/**
 * 页面 POST 与 agent runner 的自确认落行共用此入口：成员/归档门、scope 目录、
 * 区间资格及 SENSITIVE/ROOT 拒绝都只走这一条链。
 */
export async function activatePendingPermissions(
  userId: string,
  productionId: string,
  permissions: unknown,
): Promise<PermissionActivationResult> {
  const access = await getProductionPermissionContext(userId, false, productionId);
  if (!access) return { ok: false, status: 403, error: "无权访问" };
  if (access.isArchived) return { ok: false, status: 403, error: "已归档的项目不可修改" };
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return { ok: false, status: 400, error: "permissions 为必填数组" };
  }

  const nodes: NodeKeyParts[] = [];
  for (const raw of permissions) {
    if (typeof raw !== "string" || !raw.startsWith("node:")) {
      return { ok: false, status: 400, error: `无效的权限值: ${raw}` };
    }
    const node = parseNodeKey(raw);
    if (!node || !ACTIVATABLE_NODE_KEYS.includes(raw)) {
      return { ok: false, status: 400, error: `无效的权限值: ${raw}` };
    }
    nodes.push(node);
  }

  return { ok: true, confirmed: await selfConfirmTemplateNodes(userId, productionId, nodes) };
}
