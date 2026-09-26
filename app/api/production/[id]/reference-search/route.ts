import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { searchWiki } from "@/lib/wiki/links";
import { listVisibleWikiIds } from "@/lib/wiki/perm";
import { listAssets, assetTreePaths } from "@/lib/asset/db";
import { filterVisibleAssets } from "@/lib/asset/perm";
import { embedMediaKind } from "@/lib/asset/embed-media";
import { listNodeLibrary } from "@/lib/node/db";
import { getActiveVersionId } from "@/lib/script/version-db";
import { loadProduction } from "@/lib/script/script-state-db";
import { listCueListsWithAccess } from "@/lib/ops/cue-list-db";
import { listCuesByProduction } from "@/lib/ops/cue-db";
import {
  isReferenceSearchKind,
  type ReferenceSearchResult,
} from "@/lib/editor/reference-search-types";

type Ctx = { params: Promise<{ id: string }> };

const LIMIT = 20;
const matches = (values: Array<string | null | undefined>, query: string) =>
  values.some(value => value?.toLocaleLowerCase().includes(query));

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(
    session.userId, session.isAdmin, productionId,
  );
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const kind = req.nextUrl.searchParams.get("kind");
  if (!isReferenceSearchKind(kind)) {
    return Response.json({ error: "未知引用类型" }, { status: 400 });
  }
  const rawQuery = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!rawQuery) return Response.json({ results: [] });
  const query = rawQuery.slice(0, 100).toLocaleLowerCase();
  const actor = toActor(session, access.permCtx);

  if (kind === "wiki") {
    const [visible, hits] = await Promise.all([
      listVisibleWikiIds(actor, productionId),
      searchWiki(productionId, rawQuery.slice(0, 100)),
    ]);
    const results: ReferenceSearchResult[] = hits
      .filter(hit => visible.wildcard || visible.ids.has(hit.id))
      .slice(0, LIMIT)
      .map(hit => ({ kind: "wiki", id: hit.id, label: hit.title ?? "（无标题）" }));
    return Response.json({ results });
  }

  if (kind === "asset") {
    const [allAssets, library] = await Promise.all([
      listAssets(productionId),
      listNodeLibrary(productionId),
    ]);
    const visible = await filterVisibleAssets(actor, productionId, allAssets);
    const paths = assetTreePaths(library);
    const embeddableOnly = req.nextUrl.searchParams.get("embeddable") === "1";
    const results: ReferenceSearchResult[] = visible
      .filter(asset => !embeddableOnly || embedMediaKind(asset.mimeType) !== null)
      .filter(asset => matches([
        asset.name,
        asset.fileName,
        (paths.get(asset.id) ?? []).join(" / "),
      ], query))
      .slice(0, LIMIT)
      .map(asset => {
        const path = (paths.get(asset.id) ?? []).join(" / ");
        return {
          kind: "asset",
          id: asset.id,
          label: asset.name ?? asset.fileName,
          description: [path || null, asset.name ? asset.fileName : null]
            .filter((value): value is string => !!value)
            .join(" · ") || undefined,
          mimeType: asset.mimeType,
        };
      });
    return Response.json({ results });
  }

  if (kind === "scene") {
    if (!await hasEffectiveGrant(
      access.permCtx, productionId, "script", "*", "blocks", "view",
    )) {
      return Response.json({ error: "权限不足" }, { status: 403 });
    }
    const versionId = await getActiveVersionId(productionId);
    const loaded = versionId ? await loadProduction(productionId, versionId) : null;
    const results: ReferenceSearchResult[] = (loaded?.state.scenes ?? [])
      .filter(scene => matches([scene.number, scene.name], query))
      .slice(0, LIMIT)
      .map(scene => ({
        kind: "scene",
        id: scene.id,
        label: `#${scene.number}${scene.name ? ` ${scene.name}` : ""}`,
      }));
    return Response.json({ results });
  }

  const lists = await listCueListsWithAccess(productionId, session.userId, {
    seeAll: access.permCtx.isOwner,
  });
  if (lists.length === 0) return Response.json({ results: [] });
  const listById = new Map(lists.map(list => [list.id, list]));
  const versionId = await getActiveVersionId(productionId);
  const cues = await listCuesByProduction(productionId, versionId ?? undefined);
  const seen = new Set<string>();
  const results: ReferenceSearchResult[] = [];
  for (const cue of cues) {
    const list = listById.get(cue.cueListId);
    if (!list || seen.has(cue.cueId)) continue;
    const code = `${list.abbr ? `${list.abbr}.` : ""}${cue.number}`;
    if (!matches([code, cue.number, cue.name, list.name], query)) continue;
    seen.add(cue.cueId);
    results.push({
      kind: "cue",
      id: cue.cueId,
      label: `#${code}${cue.name ? ` · ${cue.name}` : ""}`,
      description: list.name,
    });
    if (results.length >= LIMIT) break;
  }
  return Response.json({ results });
}
