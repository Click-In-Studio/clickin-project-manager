import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getPool } from "@/lib/pg";

// DELETE /api/admin/bot-testers/[openId] — remove a tester
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ openId: string }> },
) {
  const session = getSession(await cookies());
  if (!session?.isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { openId } = await params;
  await getPool().query("DELETE FROM bot_testers WHERE open_id = $1", [openId]);
  return NextResponse.json({ ok: true });
}
