import { type NextRequest, NextResponse } from "next/server";
import { deleteChatSession, renameChatSession } from "@/lib/agent-gateway/client";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";
import { shouldUseRunner } from "@/lib/agent-runtime/dispatch";
import { deleteSession, renameSession } from "@/lib/agent-runtime/service";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  const { key } = await params;
  const denied = requireOwnership(key, auth.userId);
  if (denied) return denied;

  let body: { title?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { title } = body;
  if (!title || typeof title !== "string") {
    return NextResponse.json({ error: "缺少 title" }, { status: 400 });
  }

  try {
    if (await shouldUseRunner(key)) await renameSession(key, title);
    else await renameChatSession(key, title);
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
    if (await shouldUseRunner(key)) await deleteSession(key);
    else await deleteChatSession(key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
