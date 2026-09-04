import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
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
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  // #420：挂载一律锚稳定 block_id，无版本分辨路径（?v= 兼容忽略）
  const rows = await getPool().query<BlockAssetRow>(
    `SELECT
       nm.mount_id AS block_id,
       a.id AS asset_id,
       a.name,
       a.file_name
     FROM node_mount nm
     JOIN node n ON n.id = nm.node_id
     JOIN asset a ON a.id = n.asset_id
     WHERE nm.production_id = $1
       AND nm.mount_type = 'block'
     ORDER BY nm.created_at DESC`,
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
