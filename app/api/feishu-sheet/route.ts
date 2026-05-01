import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { parseSheetUrl, resolveWikiToSheetToken, listSheets } from "@/lib/import/feishu-sheet";

/**
 * GET /api/feishu-sheet?url=<feishu-sheet-or-wiki-url>
 * Resolves the URL to a spreadsheet token and lists available worksheets.
 */
export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (!url) return Response.json({ error: "缺少 url 参数" }, { status: 400 });

  const parsed = parseSheetUrl(url);
  if (!parsed) return Response.json({ error: "无法识别的飞书表格链接" }, { status: 400 });

  try {
    let spreadsheetToken: string;
    if (parsed.kind === "wiki") {
      spreadsheetToken = await resolveWikiToSheetToken(parsed.wikiToken, userToken);
    } else {
      spreadsheetToken = parsed.token;
    }

    const sheets = await listSheets(spreadsheetToken, userToken);
    return Response.json({ spreadsheetToken, sheets });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "获取表格失败";
    const code = (err as { feishuCode?: number }).feishuCode;
    if (code === 99991671 || code === 99991663) {
      return Response.json({ error: "无权访问该表格，请确认您有阅读权限" }, { status: 403 });
    }
    return Response.json({ error: msg }, { status: 400 });
  }
}
