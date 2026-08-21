import { type NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/agent-gateway/http";
import {
  INSTRUCTIONS_MAX_LEN,
  getAgentInstructions,
  setAgentInstructions,
} from "@/lib/agent-instructions";
import { getProductionPermissionContext, getUserProfile } from "@/lib/db";
import { canAccessNode } from "@/lib/grant-template";

export const runtime = "nodejs";

// agents.md 编辑面（个人 / 制作两级；系统级在 openclaw-workspace/ 版本控制，
// 刻意无在线编辑）。制作级权限节点 ai_instructions/*@edit：制作人经模版
// node:*/*@* 类型通配覆盖（区间→需自确认激活，与全站激活制一致），POC 的
// 部门区间不含此键——「默认仅制作人、不给 POC」由此天然成立，模版零改动。
// isAdmin 取 DB profile 真值——session.isAdmin 是恒 false 的死字段（#281）。

async function productionEditAccess(userId: string, productionId: string): Promise<boolean> {
  const profile = await getUserProfile(userId);
  if (!profile) return false;
  const access = await getProductionPermissionContext(userId, profile.isAdmin, productionId);
  if (!access) return false;
  const { permCtx } = access;
  const decision = await canAccessNode(
    { userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner },
    productionId,
    "ai_instructions",
    "*",
    "*",
    "edit",
  );
  return decision.allowed;
}

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
