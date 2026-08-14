import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { getProductionDept } from "@/lib/dept-db";
import { listDeptPermissionRows, setDeptPermissionRows } from "@/lib/perm-center-db";
import { isGovernanceNodeKey } from "@/lib/grant-template";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

// 部门权限行（production_dept_permission 区间）。
// 可见门与可改门分离：view=org_dept/*/grants@view（edit 覆盖读），edit=org_dept/*/grants@edit。

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, deptId } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [
    ["org_dept", "grants", "view"],
    ["org_dept", "grants", "edit"],
  ]);
  if (deny) return deny;
  const dept = await getProductionDept(deptId, id);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });
  const rows = await listDeptPermissionRows(id);
  return Response.json({ keys: rows[deptId] ?? [] });
}

/** PUT — 全量替换该部门的权限行。Body: { keys: string[] } */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id, deptId } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [["org_dept", "grants", "edit"]], { blockArchived: true });
  if (deny) return deny;
  const dept = await getProductionDept(deptId, id);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });

  const body = (await req.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys) || body.keys.some(k => typeof k !== "string")) {
    return Response.json({ error: "keys 必须为字符串数组" }, { status: 400 });
  }
  const keys = body.keys as string[];
  for (const key of keys) {
    // 宽松键形校验（含批G 通配区间键：type/verb 位可为 *）；null=非法
    if (isGovernanceNodeKey(key) === null) {
      return Response.json({ error: `非法权限键：${key}` }, { status: 400 });
    }
  }
  await setDeptPermissionRows(id, deptId, keys);
  return Response.json({ ok: true, keys: [...new Set(keys)] });
}
