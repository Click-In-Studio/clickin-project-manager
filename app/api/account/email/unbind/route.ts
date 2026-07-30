import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { unbindEmail } from "@/lib/db";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { upiId } = await req.json() as { upiId?: string };
  if (!upiId) return NextResponse.json({ error: "missing upiId" }, { status: 400 });

  try {
    await unbindEmail(session.userId, upiId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const status = msg === "identity not found" ? 404 : msg === "last login method" ? 409 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
