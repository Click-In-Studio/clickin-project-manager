import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getUserIdentities } from "@/lib/db";

export async function GET() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const identities = await getUserIdentities(session.userId);
  return Response.json(identities);
}
