import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction, cowBlockSnapshotForMount, cowCueRevisionForMount, getVersion } from "@/lib/db";
import { getAsset, addAssetMount, listAssetMounts, type MountType, type MountMode } from "@/lib/asset-db";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

async function validateVersion(productionId: string, versionId?: string | null) {
  if (!versionId) return true;
  const version = await getVersion(versionId);
  return version?.productionId === productionId;
}

async function validateMountTarget(productionId: string, mountType: MountType, mountId: string) {
  const pool = getPool();
  switch (mountType) {
    case "production":
      return mountId === productionId;
    case "version": {
      const res = await pool.query("SELECT 1 FROM version WHERE id = $1 AND production_id = $2", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "scene":
    case "scene_snapshot": {
      const res = await pool.query("SELECT 1 FROM scene WHERE id = $1 AND production_id = $2", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "block": {
      const res = await pool.query("SELECT 1 FROM script WHERE block_id = $1 AND production_id = $2 LIMIT 1", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "block_snapshot": {
      const res = await pool.query("SELECT 1 FROM script WHERE id = $1 AND production_id = $2", [mountId, productionId]);
      return res.rows.length > 0;
    }
    case "cue":
    case "cue_revision": {
      const idColumn = mountType === "cue" ? "c.cue_id" : "c.id";
      const res = await pool.query(
        `SELECT 1
         FROM cue c
         JOIN cue_list cl ON cl.id = c.cue_list_id
         WHERE ${idColumn} = $1 AND cl.production_id = $2
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
    case "event_tech_req": {
      const res = await pool.query(
        `SELECT 1
         FROM event_tech_req etr
         JOIN production_event pe ON pe.id = etr.event_id
         WHERE etr.id = $1 AND pe.production_id = $2`,
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
    default:
      return false;
  }
}

async function validateVersionedMountTarget(versionId: string, mountType: MountType, mountId: string) {
  const pool = getPool();
  if (mountType === "block_snapshot") {
    const res = await pool.query(
      "SELECT 1 FROM script_version WHERE version_id = $1 AND snapshot_id = $2",
      [versionId, mountId]
    );
    return res.rows.length > 0;
  }
  if (mountType === "cue_revision") {
    const res = await pool.query(
      "SELECT 1 FROM cue_version WHERE version_id = $1 AND revision_id = $2",
      [versionId, mountId]
    );
    return res.rows.length > 0;
  }
  return false;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.userId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  const mounts = await listAssetMounts(assetId);
  return Response.json({ mounts });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.userId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  const isOwner = asset.uploaderUserId === session.userId;
  if (!isOwner && !session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    mountType: MountType;
    mountId: string;
    mountAuxId?: string | null;
    folderPath?: string | null;
    mountMode?: MountMode | null;
    versionResolved?: boolean | null;
    versionId?: string | null; // required for block_snapshot/cue_revision CoW
  };

  if (!body.mountType || !body.mountId)
    return Response.json({ error: "缺少 mountType 或 mountId" }, { status: 400 });

  let mountId = body.mountId;
  const mode = body.mountMode;
  if (!(await validateMountTarget(id, body.mountType, mountId))) {
    return Response.json({ error: "挂载目标不存在" }, { status: 404 });
  }

  // Perform CoW split before inserting mount, when required by mount mode
  if (mode === "tracking" || mode === "version_only") {
    if (!body.versionId)
      return Response.json({ error: "tracking/version_only 模式需要提供 versionId" }, { status: 400 });
    if (!(await validateVersion(id, body.versionId))) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
    if (!(await validateVersionedMountTarget(body.versionId, body.mountType, mountId))) {
      return Response.json({ error: "挂载目标不属于该版本" }, { status: 404 });
    }

    if (body.mountType === "block_snapshot") {
      mountId = await cowBlockSnapshotForMount(body.versionId, mountId, mode);
    } else if (body.mountType === "cue_revision") {
      mountId = await cowCueRevisionForMount(body.versionId, mountId, mode);
    }
  }

  const mount = await addAssetMount({
    assetId, productionId: id,
    mountType: body.mountType, mountId,
    mountAuxId: body.mountAuxId, folderPath: body.folderPath,
    mountMode: mode ?? null, versionResolved: body.versionResolved,
    createdBy: session.userId,
  });
  return Response.json({ mount }, { status: 201 });
}
