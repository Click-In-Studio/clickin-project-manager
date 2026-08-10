import { type NextRequest, NextResponse } from "next/server";
import { deleteChatSession, renameChatSession } from "@/lib/agent-gateway/client";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  const { key } = await params;
  const denied = requireOwnership(key, auth.userId);
  if (denied) return denied;

  try {
    const { title } = await req.json();
    if (!title || typeof title !== "string") {
      return NextResponse.json({ error: "缺少 title" }, { status: 400 });
    }
    await renameChatSession(key, title);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  const { key } = await params;
  const denied = requireOwnership(key, auth.userId);
  if (denied) return denied;

  try {
    await deleteChatSession(key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
