import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSheetValues } from "@/lib/import/feishu-sheet";
import { parseSceneNum } from "@/lib/import/parse-scene-num";
import { getProductionMemberContext, getVersion, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import type { JointImportMarker, JointImportMappingRow, JointImportPreview, SceneColMap, ScriptColMap } from "@/lib/import/types";

const SCENE_MARKER_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

type JointImportBody = {
  dramaturgy?: {
    spreadsheetToken: string;
    sheetId: string;
    rowCount?: number;
    colMap: SceneColMap;
    headerRowIncluded?: boolean;
    rows?: (string | null)[][];
  } | null;
  script: {
    spreadsheetToken: string;
    sheetId: string;
    rowCount?: number;
    colMap: ScriptColMap;
    headerRowIncluded?: boolean;
    rows?: (string | null)[][];
  };
};

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return { session, deny: Response.json({ error: "已归档" }, { status: 403 }) };
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) {
    return { session, deny: Response.json({ error: "仅制作人可导入数据" }, { status: 403 }) };
  }
  return { session, deny: null };
}

async function resolveImportVersionId(req: NextRequest, productionId: string): Promise<string | Response> {
  const versionIdParam = req.nextUrl.searchParams.get("v");
  if (!versionIdParam) {
    const versionId = await getActiveVersionId(productionId);
    return versionId ?? Response.json({ error: "没有可编辑的版本，请先创建一个版本" }, { status: 400 });
  }
  const ver = await getVersion(versionIdParam);
  if (!ver || ver.productionId !== productionId) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  if (ver.status !== "editing") {
    return Response.json({ error: "只能向编辑中的版本导入数据" }, { status: 400 });
  }
  return versionIdParam;
}

function dataRows(rows: (string | null)[][], headerRowIncluded?: boolean) {
  if (!headerRowIncluded) return rows;
  const headerIndex = rows.findIndex(row => row.some(cell => cell?.trim()));
  if (headerIndex < 0) return [];
  return rows.filter((_, index) => index !== headerIndex);
}

function getCell(row: (string | null)[], col: number | undefined): string | null {
  if (col == null) return null;
  return row[col]?.trim() || null;
}

function upsertMarker(markers: JointImportMarker[], next: JointImportMarker) {
  if (!next.num) return;
  const existing = markers.find(marker => marker.num === next.num);
  if (!existing) {
    markers.push(next);
    return;
  }
  if (next.name && !existing.name) existing.name = next.name;
  if (next.synopsis && !existing.synopsis) existing.synopsis = next.synopsis;
  if (next.actionLine && !existing.actionLine) existing.actionLine = next.actionLine;
  if (next.music && !existing.music) existing.music = next.music;
  if (next.stageNotes && !existing.stageNotes) existing.stageNotes = next.stageNotes;
  if (next.expectedDuration && !existing.expectedDuration) existing.expectedDuration = next.expectedDuration;
}

function extractMarkersFromScript(rows: (string | null)[][], body: JointImportBody["script"]): JointImportMarker[] {
  const markers: JointImportMarker[] = [];
  for (const row of dataRows(rows, body.headerRowIncluded)) {
    const rawNum = getCell(row, body.colMap.sceneNum);
    if (!rawNum) continue;
    const parsed = parseSceneNum(rawNum);
    if (!parsed) continue;
    if (parsed.parentNum) {
      upsertMarker(markers, { num: parsed.parentNum, name: parsed.parentName ?? "", parentNum: null });
    }
    if (parsed.childNum) {
      upsertMarker(markers, { num: parsed.childNum, name: parsed.childName ?? "", parentNum: parsed.parentNum });
    }
  }
  return markers;
}

function extractMarkersFromDramaturgy(rows: (string | null)[][], body: NonNullable<JointImportBody["dramaturgy"]>): JointImportMarker[] {
  const markers: JointImportMarker[] = [];
  for (const row of dataRows(rows, body.headerRowIncluded)) {
    const rawNum = getCell(row, body.colMap.sceneNum);
    if (!rawNum) continue;
    const parsed = parseSceneNum(rawNum);
    if (!parsed) continue;
    const rowName = getCell(row, body.colMap.sceneName);
    if (parsed.parentNum) {
      upsertMarker(markers, {
        num: parsed.parentNum,
        name: parsed.childNum ? (parsed.parentName ?? "") : (rowName ?? parsed.parentName ?? ""),
        parentNum: null,
      });
    }
    const childOrParentNum = parsed.childNum ?? parsed.parentNum;
    if (childOrParentNum) {
      upsertMarker(markers, {
        num: childOrParentNum,
        name: parsed.childNum ? (rowName ?? parsed.childName ?? "") : (rowName ?? parsed.parentName ?? ""),
        parentNum: parsed.childNum ? parsed.parentNum : null,
        synopsis: getCell(row, body.colMap.intro) ?? undefined,
        actionLine: getCell(row, body.colMap.actionLine) ?? undefined,
        music: getCell(row, body.colMap.music) ?? undefined,
        stageNotes: getCell(row, body.colMap.stagePres) ?? undefined,
        expectedDuration: getCell(row, body.colMap.duration) ?? undefined,
      });
    }
  }
  return markers;
}

function buildMappingRows(extracted: JointImportMarker[], imported: JointImportMarker[]): JointImportMappingRow[] {
  const extractedChapterOrder = chapterOrderByNum(extracted);
  const importedChapterOrder = chapterOrderByNum(imported);
  const rows: JointImportMappingRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < extracted.length || rightIndex < imported.length) {
    const left = extracted[leftIndex] ?? null;
    const right = imported[rightIndex] ?? null;
    let extractedMarker: JointImportMarker | null = null;
    let importedMarker: JointImportMarker | null = null;
    if (left && right && left.num === right.num) {
      extractedMarker = left;
      importedMarker = right;
      leftIndex++;
      rightIndex++;
    } else if (left && right && markerScopesMatch(left, right, extractedChapterOrder, importedChapterOrder)) {
      const order = SCENE_MARKER_COLLATOR.compare(left.num, right.num);
      if (order < 0) {
        extractedMarker = left;
        leftIndex++;
      } else {
        importedMarker = right;
        rightIndex++;
      }
    } else if (left && right && !left.parentNum && right.parentNum) {
      importedMarker = right;
      rightIndex++;
    } else if (left && (!right || (left.parentNum && !right.parentNum))) {
      extractedMarker = left;
      leftIndex++;
    } else if (right) {
      importedMarker = right;
      rightIndex++;
    }
    if (!extractedMarker && !importedMarker) continue;
    rows.push({
      id: `row:${rows.length}:l-${extractedMarker?.num ?? "na"}:r-${importedMarker?.num ?? "na"}`,
      extracted: extractedMarker,
      imported: importedMarker,
    });
  }
  return rows;
}

function markerScopesMatch(
  left: JointImportMarker,
  right: JointImportMarker,
  extractedChapterOrder: Map<string, number>,
  importedChapterOrder: Map<string, number>,
): boolean {
  if (!left.parentNum && !right.parentNum) return true;
  if (!left.parentNum || !right.parentNum) return false;
  return extractedChapterOrder.get(left.parentNum) === importedChapterOrder.get(right.parentNum);
}

function chapterOrderByNum(markers: JointImportMarker[]): Map<string, number> {
  const order = new Map<string, number>();
  let next = 0;
  for (const marker of markers) {
    if (marker.parentNum) continue;
    if (!order.has(marker.num)) order.set(marker.num, next++);
  }
  return order;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { deny } = await guard(req, productionId);
  if (deny) return deny;

  const body = (await req.json()) as JointImportBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });

  const versionId = await resolveImportVersionId(req, productionId);
  if (versionId instanceof Response) return versionId;

  const [scriptRows, dramaturgyRows] = await Promise.all([
    body.script.rows
      ? Promise.resolve(body.script.rows)
      : getSheetValues(body.script.spreadsheetToken, body.script.sheetId, userToken, body.script.rowCount),
    body.dramaturgy
      ? body.dramaturgy.rows
        ? Promise.resolve(body.dramaturgy.rows)
        : getSheetValues(body.dramaturgy.spreadsheetToken, body.dramaturgy.sheetId, userToken, body.dramaturgy.rowCount)
      : Promise.resolve(null),
  ]);

  const extractedMarkers = extractMarkersFromScript(scriptRows, body.script);
  const importedMarkers = dramaturgyRows && body.dramaturgy
    ? extractMarkersFromDramaturgy(dramaturgyRows, body.dramaturgy)
    : [];
  const mappingRows = body.dramaturgy
      ? buildMappingRows(extractedMarkers, importedMarkers)
      : extractedMarkers.map((marker, index) => ({
          id: `row:${index}:${marker.num}`,
          extracted: marker,
          imported: null,
        }));

  const preview: JointImportPreview = { extractedMarkers, importedMarkers, mappingRows };
  return Response.json({ preview });
}
