import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getActiveVersionId, getVersion } from "@/lib/script/version-db";
import { getPool } from "@/lib/pg";

async function resolveVersion(req: NextRequest, productionId: string): Promise<string | null> {
  const requested = req.nextUrl.searchParams.get("v");
  const versionId = requested ?? await getActiveVersionId(productionId);
  if (!versionId) return null;
  const version = await getVersion(versionId);
  return version?.productionId === productionId ? versionId : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/window-search">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !await hasEffectiveGrant(access.permCtx, id, "script", "*", "blocks", "view")) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }
  const versionId = await resolveVersion(req, id);
  if (!versionId) return Response.json({ error: "无可用版本" }, { status: 404 });
  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json({ matches: [] });
  const exact = req.nextUrl.searchParams.get("exact") === "1";
  const operator = exact ? "LIKE" : "ILIKE";
  const res = await getPool().query<{ id: string; index: number }>(
    `WITH ordered AS (
       SELECT sv.block_id AS id, s.type, s.content,
              (row_number() OVER (ORDER BY sv.sort_key) - 1)::int AS index
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
     )
     SELECT id, index
     FROM ordered
     WHERE type NOT IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
       AND regexp_replace(content, '<[^>]+>', '', 'g') ${operator} $2 ESCAPE '\\'
     ORDER BY index`,
    [versionId, `%${escapeLike(query)}%`],
  );
  return Response.json({ matches: res.rows });
}
