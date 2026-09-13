import { type NextRequest } from "next/server";
import { dispatchWeeklyCall } from "@/lib/notify/notify";

function authorized(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!secret) return false;
  return req.headers.get("Authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const result = await dispatchWeeklyCall(dry);
  return Response.json(result);
}
