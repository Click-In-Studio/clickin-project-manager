import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import { getPool } from "@/lib/pg";

// Resolves stable block/cue IDs to their snapshot/revision IDs for the given version.
// GET ?type=block&stableId={blockId}&v={versionId}  → { mountType: "block_snapshot", mountId, stableId }
// GET ?type=cue&stableId={cueId}&v={versionId}      → { mountType: "cue_revision",   mountId, stableId }

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const type = sp.get("type");
  const stableId = sp.get("stableId");
  const versionId = sp.get("v");

  if (!type || !stableId || !versionId)
    return Response.json({ error: "缺少 type / stableId / v 参数" }, { status: 400 });

  if (type === "block") {
    const res = await getPool().query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM script_version WHERE block_id = $1 AND version_id = $2 LIMIT 1`,
      [stableId, versionId]
    );
    if (!res.rows[0]) return Response.json({ error: "未找到 block snapshot" }, { status: 404 });
    return Response.json({ mountType: "block_snapshot", mountId: res.rows[0].snapshot_id, stableId });
  }

  if (type === "cue") {
    const res = await getPool().query<{ revision_id: string }>(
      `SELECT revision_id FROM cue_version WHERE cue_id = $1 AND version_id = $2 LIMIT 1`,
      [stableId, versionId]
    );
    if (!res.rows[0]) return Response.json({ error: "未找到 cue revision" }, { status: 404 });
    return Response.json({ mountType: "cue_revision", mountId: res.rows[0].revision_id, stableId });
  }

  return Response.json({ error: "type 只支持 block 或 cue" }, { status: 400 });
}
