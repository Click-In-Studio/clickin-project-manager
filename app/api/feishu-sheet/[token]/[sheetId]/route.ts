import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSheetValues, parseSheetData } from "@/lib/import/feishu-sheet";

/**
 * GET /api/feishu-sheet/[token]/[sheetId]
 * Returns parsed headers and data rows for a single worksheet.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string; sheetId: string }> },
) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });

  const { token: spreadsheetToken, sheetId } = await ctx.params;

  try {
    const rawRows = await getSheetValues(spreadsheetToken, sheetId, userToken);
    const data = parseSheetData(rawRows);
    return Response.json({ data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "读取表格数据失败";
    const code = (err as { feishuCode?: number }).feishuCode;
    if (code === 99991671 || code === 99991663) {
      return Response.json({ error: "无权访问该表格" }, { status: 403 });
    }
    return Response.json({ error: msg }, { status: 400 });
  }
}
