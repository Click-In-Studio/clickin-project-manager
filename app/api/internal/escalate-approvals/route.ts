import { type NextRequest } from "next/server";
import { escalateExpiredApprovals } from "@/lib/db";

function authorized(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!secret) return false;
  return req.headers.get("Authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await escalateExpiredApprovals();
  return Response.json(result);
}
