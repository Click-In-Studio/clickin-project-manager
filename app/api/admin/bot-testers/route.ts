import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getPool } from "@/lib/pg";
import { getUserName as fetchFeishuName } from "@/lib/feishu-webhook";

function adminOnly() {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

// GET /api/admin/bot-testers — list all testers
export async function GET() {
  const session = getSession(await cookies());
  if (!session?.isAdmin) return adminOnly();

  const { rows } = await getPool().query(
    "SELECT open_id, name, added_at FROM bot_testers ORDER BY added_at",
  );
  return NextResponse.json({ testers: rows });
}

// POST /api/admin/bot-testers — add a tester { openId, name? }
export async function POST(req: NextRequest) {
  const session = getSession(await cookies());
  if (!session?.isAdmin) return adminOnly();

  const { openId, name } = await req.json() as { openId?: string; name?: string };
  if (!openId) return NextResponse.json({ error: "openId required" }, { status: 400 });

  // Look up name from Feishu if not provided
  const resolvedName = name?.trim() || await fetchFeishuName(openId);

  await getPool().query(
    "INSERT INTO bot_testers (open_id, name) VALUES ($1, $2) ON CONFLICT (open_id) DO UPDATE SET name = EXCLUDED.name",
    [openId, resolvedName],
  );
  return NextResponse.json({ ok: true, openId, name: resolvedName });
}
