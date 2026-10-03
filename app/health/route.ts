import type { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!secret || req.headers.get("Authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await getPool().query("SELECT 1");
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
