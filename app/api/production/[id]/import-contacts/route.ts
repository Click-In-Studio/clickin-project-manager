import { type NextRequest } from "next/server";
import { getAppAccessToken, searchUsersByName, getUserContactInfo } from "@/lib/feishu-auth";
import {
  parseWikiUrl,
  resolveWikiToken,
  getFirstTable,
  getTableFields,
  getAllRecords,
  validateContactSchema,
  toContactRows,
} from "@/lib/feishu-bitable";
import {
  findUserByName,
  upsertContactUser,
  upsertProductionMemberWithRoles,
} from "@/lib/db";
import { getSession } from "@/lib/session";
import { ALL_ROLES } from "@/lib/roles";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;

  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "仅超级管理员可操作" }, { status: 403 });

  const body = (await req.json()) as { wikiUrl?: string };
  if (!body.wikiUrl) return Response.json({ error: "wikiUrl 为必填" }, { status: 400 });

  const wikiToken = parseWikiUrl(body.wikiUrl);
  if (!wikiToken) return Response.json({ error: "无法解析 Wiki 链接" }, { status: 400 });

  const token = await getAppAccessToken();

  let appToken: string;
  let tableId: string;
  try {
    appToken = await resolveWikiToken(wikiToken, token);
    tableId = await getFirstTable(appToken, token);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const fields = await getTableFields(appToken, tableId, token);
  const validation = validateContactSchema(fields);
  if (!validation.ok) {
    return Response.json({ error: "表格结构不匹配", details: validation.errors }, { status: 400 });
  }

  const records = await getAllRecords(appToken, tableId, token);
  const { rows, errors: parseErrors } = toContactRows(validation.fieldMap, records, ALL_ROLES);

  // Non-fatal parse errors (unknown roles, skipped rows) are returned as warnings.
  // Fatal: no valid rows at all.
  if (rows.length === 0) {
    return Response.json(
      { error: "没有可导入的人员", details: parseErrors },
      { status: 400 }
    );
  }

  const stats = { matched: 0, created: 0, notFound: [] as string[] };

  for (const row of rows) {
    // ── Step 1: resolve open_id ───────────────────────────────────────────────
    let openId: string | null = null;
    let isNew = false;

    if (row.feishuOpenId) {
      // Person column present and filled — use directly, no search needed.
      openId = row.feishuOpenId;
      const alreadyKnown = await findUserByName(row.name);
      isNew = !alreadyKnown;
    } else {
      const existing = await findUserByName(row.name);
      if (existing) {
        openId = existing.openId;
      } else {
        // Search Feishu directory by name.
        try {
          const candidates = await searchUsersByName(row.name);
          const match = candidates.find((u) => u.name === row.name);
          if (match) { openId = match.openId; isNew = true; }
        } catch { /* fall through to notFound */ }
      }
    }

    if (!openId) {
      stats.notFound.push(row.name);
      continue;
    }

    // ── Step 2: supplement email/phone from Feishu if sheet left them blank ──
    let { email, phone } = row;
    let avatarUrl: string | null = null;

    if (!email || !phone) {
      const info = await getUserContactInfo(openId);
      email ??= info.email;
      phone ??= info.phone;
      avatarUrl = info.avatarUrl;
    }

    // ── Step 3: persist ───────────────────────────────────────────────────────
    await upsertContactUser(openId, row.name, avatarUrl, email, phone);
    await upsertProductionMemberWithRoles(productionId, openId, row.roles, row.photoUrl);

    if (isNew) stats.created++; else stats.matched++;
  }

  return Response.json({
    ok: true,
    stats,
    warnings: parseErrors.length > 0 ? parseErrors : undefined,
  });
}
