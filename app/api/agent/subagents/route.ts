import { NextResponse, type NextRequest } from "next/server";
import { requireUser, toErrorResponse } from "@/lib/agent/chat/http";
import { requireSubagentParent } from "@/lib/agent/runtime/subagent-route-auth";
import { listSubagents, ownSubagent } from "@/lib/agent/runtime/subagent-db";
import { readSubagent } from "@/lib/agent/runtime/subagents";
import { stopSubagent } from "@/lib/agent/runtime/client";

export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    const auth = await requireSubagentParent(
      req,
      req.nextUrl.searchParams.get("sessionKey"),
    );
    if (auth instanceof Response) return auth;
    const id = req.nextUrl.searchParams.get("subagentId");
    if (id) {
      const cursor = Number(req.nextUrl.searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        return NextResponse.json({ error: "游标非法" }, { status: 400 });
      return NextResponse.json(
        JSON.parse(await readSubagent(auth.sessionKey, id, cursor)),
      );
    }
    return NextResponse.json({
      subagents: (await listSubagents(auth.sessionKey)).map((row) => ({
        ...row,
        result: row.result?.slice(0, 800) ?? null,
      })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
export async function POST(req: NextRequest) {
  const user = requireUser(req.cookies);
  if (user instanceof NextResponse) return user;
  let body: { sessionKey?: unknown; subagentId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 非法" }, { status: 400 });
  }
  try {
    const auth = await requireSubagentParent(
      req,
      typeof body.sessionKey === "string" ? body.sessionKey : null,
    );
    if (auth instanceof Response) return auth;
    if (typeof body.subagentId !== "string")
      return NextResponse.json({ error: "缺少 subagentId" }, { status: 400 });
    await ownSubagent(auth.sessionKey, body.subagentId);
    await stopSubagent(auth.sessionKey, body.subagentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
