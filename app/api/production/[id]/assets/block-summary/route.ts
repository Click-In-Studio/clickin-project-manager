import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction, getVersion } from "@/lib/db";
import { getPool } from "@/lib/pg";

type BlockAssetRow = {
  block_id: string;
  asset_id: string;
  name: string | null;
  file_name: string;
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.userId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const versionId = req.nextUrl.searchParams.get("v");
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  const rows = versionId
    ? await getPool().query<BlockAssetRow>(
        `WITH version_blocks AS (
           SELECT block_id, snapshot_id FROM script_version WHERE version_id = $2
         )
         SELECT
           vb.block_id,
           a.id AS asset_id,
           a.name,
           a.file_name
         FROM asset_mount am
         JOIN asset a ON a.id = am.asset_id
         JOIN version_blocks vb
           ON am.mount_type = 'block_snapshot'
          AND am.mount_id = vb.snapshot_id
         WHERE am.production_id = $1
           AND am.mount_type = 'block_snapshot'
         ORDER BY am.created_at DESC`,
        [id, versionId]
      )
    : await getPool().query<BlockAssetRow>(
        `SELECT
           am.mount_id AS block_id,
           a.id AS asset_id,
           a.name,
           a.file_name
         FROM asset_mount am
         JOIN asset a ON a.id = am.asset_id
         WHERE am.production_id = $1
           AND am.mount_type = 'block'
         ORDER BY am.created_at DESC`,
        [id]
      );

  return Response.json({
    blocks: rows.rows.map(row => ({
      blockId: row.block_id,
      asset: {
        id: row.asset_id,
        name: row.name,
        fileName: row.file_name,
      },
    })),
  });
}
