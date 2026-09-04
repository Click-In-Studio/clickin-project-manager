import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset } from "@/lib/asset/db";
import { getNodeByAssetId } from "@/lib/node/db";
import { addNodeMount, listNodeMounts, type MountType } from "@/lib/node/mount";
import { canViewAsset, canPublishAsset, mountHostSidePermitted } from "@/lib/asset/perm";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

// 挂载目标存在性校验（多态 mount_id 无 FK，归属校验在应用层——node 契约）。
// #420 退役词汇不再受理：production（≡树可枚举）、wiki（→embed）、version/
// scene_snapshot/block_snapshot/cue_revision（版本纪律：挂载锚稳定 id）。
async function validateMountTarget(productionId: string, mountType: MountType, mountId: string) {
  const pool = getPool();
  switch (mountType) {
    case "scene": {
      const res = await pool.query("SELECT 1 FROM scene WHERE id = $1 AND production_id = $2", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "block": {
      const res = await pool.query("SELECT 1 FROM script WHERE block_id = $1 AND production_id = $2 LIMIT 1", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "cue": {
      const res = await pool.query(
        `SELECT 1
         FROM cue c
         JOIN cue_list cl ON cl.id = c.cue_list_id
         WHERE c.cue_id = $1 AND cl.production_id = $2
         LIMIT 1`,
        [mountId, productionId]
      );
      return res.rows.length > 0;
    }
    case "comment": {
      const res = await pool.query("SELECT 1 FROM comment WHERE id = $1 AND production_id = $2", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "event": {
      const res = await pool.query("SELECT 1 FROM production_event WHERE id = $1 AND production_id = $2", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "event_schedule": {
      const res = await pool.query(
        `SELECT 1
         FROM event_schedule_item esi
         JOIN production_event pe ON pe.id = esi.event_id
         WHERE esi.id = $1 AND pe.production_id = $2`,
        [mountId, productionId]
      );
      return res.rows.length > 0;
    }
    case "task": {
      const res = await pool.query(
        "SELECT 1 FROM task WHERE id = $1 AND production_id = $2",
        [mountId, productionId]
      );
      return res.rows.length > 0;
    }
    case "event_report": {
      const res = await pool.query(
        `SELECT 1
         FROM event_report er
         JOIN production_event pe ON pe.id = er.event_id
         WHERE er.id = $1 AND pe.production_id = $2`,
        [mountId, productionId]
      );
      return res.rows.length > 0;
    }
    case "embed": {
      // 嵌入边宿主是 wiki 正文（uuid）——id::text 对比，坏 id 不炸 cast
      const res = await pool.query("SELECT 1 FROM wiki WHERE id::text = $1 AND production_id = $2", [mountId, productionId]);
      return res.rows.length > 0;
    }
    default:
      return false;
  }
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  if (!await canViewAsset(access.permCtx, id, asset, "meta"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const shell = await getNodeByAssetId(assetId);
  const mounts = shell ? await listNodeMounts(shell.id) : [];
  return Response.json({ mounts });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  const body = (await req.json()) as {
    mountType: MountType;
    mountId: string;
    mountAuxId?: string | null;
  };

  if (!body.mountType || !body.mountId)
    return Response.json({ error: "缺少 mountType 或 mountId" }, { status: 400 });

  // 批D 双门：挂载 = asset publication@create（主人侧让渡）∧ 宿主侧 attach
  if (!await canPublishAsset(access.permCtx, id, assetId, "create")
      || !await mountHostSidePermitted(access.permCtx, id, body.mountType, body.mountId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  if (!(await validateMountTarget(id, body.mountType, body.mountId))) {
    return Response.json({ error: "挂载目标不存在" }, { status: 404 });
  }

  const shell = await getNodeByAssetId(assetId);
  if (!shell || shell.productionId !== id)
    return Response.json({ error: "不存在" }, { status: 404 });

  const mount = await addNodeMount({
    nodeId: shell.id, productionId: id,
    mountType: body.mountType, mountId: body.mountId,
    mountAuxId: body.mountAuxId,
    createdBy: session.userId,
  });
  return Response.json({ mount }, { status: 201 });
}
