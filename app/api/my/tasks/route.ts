import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { listMyTechReqsFull } from "@/lib/event-db";

export async function GET() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tasks = await listMyTechReqsFull(session.userId);
  return NextResponse.json(tasks);
}
