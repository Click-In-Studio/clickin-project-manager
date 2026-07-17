import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { canUserAccessProduction, listCues, loadProduction, getActiveVersionId, ensureScriptMarkerMigration } from "@/lib/db";
import { resolveWikiToSheet, getFirstSheetId, writeSheetData, type CellValue } from "@/lib/feishu-sheet";
import { formatCuePosition } from "@/lib/cue-export";
import type { CueAnchor } from "@/lib/cue-types";
import { textBlocksWithMarkerOwnership } from "@/lib/script-marker-blocks";

function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function anchorSortKey(anchor: CueAnchor, blockIndexMap: Map<string, number>): number {
  if (anchor.kind === "gap") {
    const i = anchor.afterBlockId !== null ? (blockIndexMap.get(anchor.afterBlockId) ?? -1) : -1;
    return (i + 1) * 1_000_000;
  }
  const i = blockIndexMap.get(anchor.blockId) ?? -1;
  return i * 1_000_000 + anchor.offset + 1;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: productionId } = await ctx.params;

  const session = getSession(req.cookies);
  if (!session) return new Response("未登录", { status: 401 });

  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return new Response("飞书登录已过期，请重新登录", { status: 401 });

  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, productionId));
  if (!ok) return new Response("权限不足", { status: 403 });

  const body = (await req.json()) as { cueListIds?: string[]; wikiUrl?: string };
  if (!body.cueListIds?.length) return new Response("cueListIds 不能为空", { status: 400 });
  if (!body.wikiUrl) return new Response("wikiUrl 不能为空", { status: 400 });

  const cueListIds = body.cueListIds;
  const wikiUrl = body.wikiUrl;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: string, data: string) => {
        try {
          controller.enqueue(enc.encode(sseFrame(event, data)));
        } catch {
          // client disconnected
        }
      };

      try {
        push("log", "正在加载剧本数据…");
        const versionId = await getActiveVersionId(productionId);
        if (!versionId) { push("error", "制作无可用版本"); controller.close(); return; }
        const migration = await ensureScriptMarkerMigration(versionId);
        if (migration.status === "running") { push("error", "剧本数据正在更新，请稍后重试"); controller.close(); return; }
        const prod = await loadProduction(productionId, versionId);
        if (!prod) { push("error", "制作不存在"); controller.close(); return; }
        const blocks = textBlocksWithMarkerOwnership(prod.state.blocks);
        const { characters } = prod.state;

        push("log", `正在加载 ${cueListIds.length} 个 Cue 表…`);
        const allCues = (await Promise.all(cueListIds.map((id) => listCues(id)))).flat();
        push("log", `已加载 ${allCues.length} 个 Cue`);

        const blockIndexMap = new Map(blocks.map((b, i) => [b.id, i]));
        const sorted = [...allCues].sort(
          (a, b) =>
            anchorSortKey(a.start, blockIndexMap) - anchorSortKey(b.start, blockIndexMap),
        );

        push("log", "正在解析飞书链接…");
        const spreadsheetToken = await resolveWikiToSheet(wikiUrl, userToken);
        push("log", "已定位电子表格");

        const { sheetId, title } = await getFirstSheetId(spreadsheetToken, userToken);
        push("log", `写入工作表「${title}」…`);

        const rows: CellValue[][] = [
          ["Cue号", "名称", "内容", "位置"],
        ];
        for (const cue of sorted) {
          rows.push([
            cue.number,
            cue.name,
            cue.content,
            formatCuePosition(cue, blocks, characters),
          ]);
        }

        await writeSheetData(spreadsheetToken, sheetId, rows, userToken);

        push("log", `✓ 导出成功（共 ${sorted.length} 个 Cue）`);
        push("done", "ok");
      } catch (e) {
        push("error", (e as Error).message ?? "未知错误");
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
