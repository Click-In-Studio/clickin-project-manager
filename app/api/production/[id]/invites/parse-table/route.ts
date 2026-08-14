import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { getAppAccessToken } from "@/lib/platform/feishu/feishu-auth";
import {
  parseWikiUrl,
  resolveWikiToken,
  getFirstTable,
  getTableFields,
  getAllRecords,
  validateInviteSchema,
  toInviteRows,
} from "@/lib/platform/feishu/feishu-bitable";
import { getProductionRoleNames } from "@/lib/db";
import { listProductionDepts } from "@/lib/dept-db";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ id: string }> };

// 邀请表格解析（#156 批量邀请替代直接导入）：解析飞书表格并做身份识别，
// 返回预览（不做任何写入）。分类：
//   registered  已注册（人员字段 open_id 或邮箱 identity 命中）
//   feishu_only 未注册但有飞书人员字段
//   email_only  未注册但有邮箱
//   none        无任何身份线索（走批量认领链接）
export type ParsedInviteRow = {
  name: string;
  roles: string[];
  unknownRoles: string[];
  deptIds: string[];
  unknownDepts: string[];
  email: string | null;
  feishuOpenId: string | null;
  category: "registered" | "feishu_only" | "email_only" | "none";
  userId: string | null;
  alreadyMember: boolean;
};

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [["member", "*", "create"]]);
  if (deny) return deny;

  const body = (await req.json()) as { wikiUrl?: string };
  if (!body.wikiUrl) return Response.json({ error: "wikiUrl 为必填" }, { status: 400 });
  const wikiToken = parseWikiUrl(body.wikiUrl);
  if (!wikiToken) return Response.json({ error: "无法解析 Wiki 链接" }, { status: 400 });

  const token = await getAppAccessToken();
  let appToken: string, tableId: string;
  try {
    appToken = await resolveWikiToken(wikiToken, token);
    tableId = await getFirstTable(appToken, token);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const fields = await getTableFields(appToken, tableId, token);
  const validation = validateInviteSchema(fields);
  if (!validation.ok) {
    return Response.json({ error: "表格结构不匹配", details: validation.errors }, { status: 400 });
  }

  const [records, validRoles, depts] = await Promise.all([
    getAllRecords(appToken, tableId, token),
    getProductionRoleNames(id),
    listProductionDepts(id),
  ]);
  const { rows: sheetRows, errors: warnings } = toInviteRows(validation.fieldMap, records, validRoles);
  if (sheetRows.length === 0) {
    return Response.json({ error: "表格没有可用行", details: warnings }, { status: 400 });
  }

  const deptByName = new Map(depts.map(d => [d.name, d.id]));
  const pool = getPool();

  // 身份识别（批量：open_id / email 两路查已注册）
  const openIds = sheetRows.map(r => r.feishuOpenId).filter((x): x is string => !!x);
  const emails = sheetRows.map(r => r.email).filter((x): x is string => !!x);
  const [byOpenId, byEmail] = await Promise.all([
    openIds.length
      ? pool.query<{ open_id: string; user_id: string }>(
          "SELECT open_id, user_id FROM feishu_user WHERE open_id = ANY($1)", [openIds])
      : Promise.resolve({ rows: [] as { open_id: string; user_id: string }[] }),
    emails.length
      ? pool.query<{ email: string; user_id: string }>(
          `SELECT LOWER(platform_user_id) AS email, user_id FROM user_platform_identity
           WHERE platform_id = 'email' AND LOWER(platform_user_id) = ANY($1)`, [emails])
      : Promise.resolve({ rows: [] as { email: string; user_id: string }[] }),
  ]);
  const openIdMap = new Map(byOpenId.rows.map(r => [r.open_id, r.user_id]));
  const emailMap = new Map(byEmail.rows.map(r => [r.email, r.user_id]));

  const memberRows = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM production_member WHERE production_id = $1", [id]);
  const memberSet = new Set(memberRows.rows.map(r => r.user_id));

  const parsed: ParsedInviteRow[] = sheetRows.map(r => {
    const userId = (r.feishuOpenId && openIdMap.get(r.feishuOpenId))
      || (r.email && emailMap.get(r.email)) || null;
    const category: ParsedInviteRow["category"] = userId
      ? "registered"
      : r.feishuOpenId ? "feishu_only"
      : r.email ? "email_only"
      : "none";
    const deptIds = r.deptNames.map(n => deptByName.get(n)).filter((x): x is string => !!x);
    const unknownDepts = r.deptNames.filter(n => !deptByName.has(n));
    return {
      name: r.name,
      roles: r.roles,
      unknownRoles: r.unknownRoles,
      deptIds,
      unknownDepts,
      email: r.email,
      feishuOpenId: r.feishuOpenId,
      category,
      userId,
      alreadyMember: !!userId && memberSet.has(userId),
    };
  });

  return Response.json({
    ok: true,
    rows: parsed,
    warnings,
    stats: {
      registered: parsed.filter(r => r.category === "registered" && !r.alreadyMember).length,
      alreadyMember: parsed.filter(r => r.alreadyMember).length,
      feishuOnly: parsed.filter(r => r.category === "feishu_only").length,
      emailOnly: parsed.filter(r => r.category === "email_only").length,
      none: parsed.filter(r => r.category === "none").length,
    },
  });
}
