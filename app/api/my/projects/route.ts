import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { listMyProductionsWithRoles } from "@/lib/db";

export async function GET() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projects = await listMyProductionsWithRoles(session.userId, session.isAdmin, []);
  return NextResponse.json(projects);
}
