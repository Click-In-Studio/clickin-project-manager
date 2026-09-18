// 「报告问题」日志（#538）。只记不改：用户提交进 bug_report，开发定期用 psql /
// listBugReports 翻看后上 issue 回填 issue_url。刻意不接 GitHub / 飞书——用户拍板
// 先只记 log，落点以后要换只改这一层。

import { randomBytes } from "node:crypto";
import { getPool } from "@/lib/pg";
import { sendEmail } from "@/lib/platform/email/email-send";
import { BUG_REPORT_INBOX, BUG_REPORT_KIND_LABELS } from "./bug-report-types";

export {
  BUG_REPORT_KINDS, BUG_REPORT_KIND_LABELS, BUG_REPORT_BODY_MAX, BUG_REPORT_HOURLY_LIMIT, BUG_REPORT_INBOX, isBugReportKind,
  type BugReportKind,
} from "./bug-report-types";
import type { BugReportKind } from "./bug-report-types";

export type BugReportInput = {
  userId: string;
  kind: BugReportKind;
  body: string;
  contact?: string | null;
  pagePath: string;
  manualSlug?: string | null;
  productionId?: string | null;
  userAgent?: string | null;
  viewport?: string | null;
};

export type BugReportRow = BugReportInput & {
  id: string;
  status: "new" | "triaged" | "filed" | "closed";
  issueUrl: string | null;
  createdAt: string;
};

/** bug_report 的 short id（仓库 id 规约：TEXT PK + 前缀 + 时间 + 随机尾）。 */
export function newBugReportId(): string {
  return `br_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/** 近一小时该用户已提交的条数（限频判据）。 */
export async function countRecentBugReports(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM bug_report WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [userId],
  );
  return Number(rows[0].n);
}

export async function insertBugReport(input: BugReportInput): Promise<string> {
  const id = newBugReportId();
  // production_id 是 FK：路径里抠出来的 id 可能已删或根本不是项目，落库前核一遍，
  // 对不上就记 NULL 而不是让整条提交 23503 失败——上下文丢一格，比丢整条报告好。
  let productionId: string | null = null;
  if (input.productionId) {
    const { rows } = await getPool().query<{ id: string }>("SELECT id FROM production WHERE id = $1", [input.productionId]);
    productionId = rows[0]?.id ?? null;
  }
  await getPool().query(
    `INSERT INTO bug_report (id, user_id, production_id, kind, body, contact, page_path, manual_slug, user_agent, viewport)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, input.userId, productionId, input.kind, input.body, input.contact ?? null,
     input.pagePath, input.manualSlug ?? null, input.userAgent ?? null, input.viewport ?? null],
  );
  return id;
}

/** 开发翻看用（也给以后的内部列表页）。默认只看 new。 */
export async function listBugReports(opts: { status?: BugReportRow["status"]; limit?: number } = {}): Promise<BugReportRow[]> {
  const status = opts.status ?? "new";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const { rows } = await getPool().query<{
    id: string; user_id: string | null; production_id: string | null; kind: BugReportKind; body: string;
    contact: string | null; page_path: string; manual_slug: string | null; user_agent: string | null;
    viewport: string | null; status: BugReportRow["status"]; issue_url: string | null; created_at: Date;
  }>(
    `SELECT id, user_id::text AS user_id, production_id, kind, body, contact, page_path, manual_slug,
            user_agent, viewport, status, issue_url, created_at
     FROM bug_report WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
    [status, limit],
  );
  return rows.map((r) => ({
    id: r.id, userId: r.user_id ?? "", productionId: r.production_id, kind: r.kind, body: r.body,
    contact: r.contact, pagePath: r.page_path, manualSlug: r.manual_slug, userAgent: r.user_agent,
    viewport: r.viewport, status: r.status, issueUrl: r.issue_url, createdAt: r.created_at.toISOString(),
  }));
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/**
 * 报告落库后抄一封到反馈邮箱（#538）。日志表是真相源，邮件只是提醒——发送失败只记
 * console，不影响用户那边的「已收到」。联系方式长得像邮箱就设成 reply-to，开发直接回。
 */
export async function emailBugReport(id: string, input: BugReportInput, reporterName: string): Promise<void> {
  const kind = BUG_REPORT_KIND_LABELS[input.kind];
  const lines: [string, string | null | undefined][] = [
    ["编号", id], ["类型", kind], ["提交人", reporterName], ["联系方式", input.contact],
    ["页面", input.pagePath], ["手册页", input.manualSlug], ["项目", input.productionId],
    ["窗口", input.viewport], ["浏览器", input.userAgent],
  ];
  const meta = lines.filter(([, v]) => v);
  const text = `${input.body}\n\n——\n${meta.map(([k, v]) => `${k}：${v}`).join("\n")}`;
  const html = `<p style="white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(input.body)}</p><hr><table style="font-size:12px;color:#666">${meta.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0">${k}</td><td>${esc(String(v))}</td></tr>`).join("")}</table>`;
  const replyTo = input.contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contact) ? input.contact : undefined;
  try {
    await sendEmail({ to: BUG_REPORT_INBOX, subject: `[报告问题·${kind}] ${input.body.slice(0, 40).replace(/\s+/g, " ")}`, text, html, replyTo });
  } catch (e) {
    console.error("[bug-report] email failed (log row kept):", e);
  }
}
