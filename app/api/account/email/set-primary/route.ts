import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { setPrimaryEmail } from "@/lib/db";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { upiId } = await req.json() as { upiId?: string };
  if (!upiId) return NextResponse.json({ error: "missing upiId" }, { status: 400 });

  try {
    await setPrimaryEmail(session.userId, upiId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    return NextResponse.json({ error: msg }, { status: msg === "identity not found" ? 404 : 400 });
  }
}
