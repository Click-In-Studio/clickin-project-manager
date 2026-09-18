import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { readJsonObject } from "@/lib/request-json";
import {
  insertBugReport, countRecentBugReports, isBugReportKind,
  BUG_REPORT_BODY_MAX, BUG_REPORT_HOURLY_LIMIT,
} from "@/lib/help/bug-report-db";

// 「报告问题」（#538）：只收登录用户——手册页是公开的，匿名表单等于开一个刷库口。
// 未登录的手册访客在页面上看到的是联系方式，不会打到这里。
export async function POST(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const b = parsed.value;

  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (!body) return Response.json({ error: "请写一下遇到了什么" }, { status: 400 });
  if (body.length > BUG_REPORT_BODY_MAX) return Response.json({ error: `最多 ${BUG_REPORT_BODY_MAX} 字` }, { status: 400 });
  const kind = isBugReportKind(b.kind) ? b.kind : "bug";
  const pagePath = typeof b.pagePath === "string" && b.pagePath.startsWith("/") ? b.pagePath.slice(0, 500) : "/";
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

  if (await countRecentBugReports(session.userId) >= BUG_REPORT_HOURLY_LIMIT) {
    return Response.json({ error: "提交太频繁了，一小时后再试" }, { status: 429 });
  }

  const id = await insertBugReport({
    userId: session.userId, kind, body,
    contact: str(b.contact, 200),
    pagePath,
    manualSlug: str(b.manualSlug, 200),
    productionId: str(b.productionId, 100),
    userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    viewport: str(b.viewport, 40),
  });
  return Response.json({ ok: true, id });
}
