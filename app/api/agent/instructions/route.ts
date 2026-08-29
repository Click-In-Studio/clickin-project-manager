import { type NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/agent-chat/http";
import {
  INSTRUCTIONS_MAX_LEN,
  canEditProductionInstructions,
  getAgentInstructions,
  setAgentInstructions,
} from "@/lib/agent-instructions";

export const runtime = "nodejs";

// agents.md 编辑面（个人 / 制作两级；系统级在 openclaw-workspace/ 版本控制，
// 刻意无在线编辑）。制作级编辑权判定见 canEditProductionInstructions
// （lib/agent-instructions.ts，与 MCP 工具共用同一个门）。
const productionEditAccess = canEditProductionInstructions;

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const productionId = req.nextUrl.searchParams.get("productionId");
  try {
    const user = await getAgentInstructions("user", auth.userId);
    if (!productionId) return NextResponse.json({ user: user ?? "" });

    // 制作级内容只回显给有编辑权的人（编辑面才需要回显；注入生效与回显
    // 无关）。无权限返回 canEdit:false、不带内容——设置页据此隐藏该节。
    const canEdit = await productionEditAccess(auth.userId, productionId);
    return NextResponse.json({
      user: user ?? "",
      production: canEdit
        ? { content: (await getAgentInstructions("production", productionId)) ?? "", canEdit: true }
        : { content: null, canEdit: false },
    });
  } catch (err) {
    console.error("[agent-instructions] GET error:", err);
    return NextResponse.json({ error: "读取失败" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let body: { scope?: unknown; productionId?: unknown; content?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { scope, productionId, content } = body;
  if (scope !== "user" && scope !== "production") {
    return NextResponse.json({ error: "scope 必须是 user 或 production" }, { status: 400 });
  }
  if (typeof content !== "string") {
    return NextResponse.json({ error: "缺少 content" }, { status: 400 });
  }
  if (content.length > INSTRUCTIONS_MAX_LEN) {
    return NextResponse.json({ error: `内容过长（上限 ${INSTRUCTIONS_MAX_LEN} 字符）` }, { status: 400 });
  }

  try {
    if (scope === "user") {
      await setAgentInstructions("user", auth.userId, content, auth.userId);
      return NextResponse.json({ ok: true });
    }
    if (!productionId || typeof productionId !== "string") {
      return NextResponse.json({ error: "缺少 productionId" }, { status: 400 });
    }
    if (!(await productionEditAccess(auth.userId, productionId))) {
      return NextResponse.json({ error: "权限不足" }, { status: 403 });
    }
    await setAgentInstructions("production", productionId, content, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[agent-instructions] PUT error:", err);
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
