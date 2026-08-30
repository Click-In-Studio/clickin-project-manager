import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getActiveVersionId, getFirstRehearsalMarkerLabel, getMasterScriptViewId, getVersion, loadProduction, saveScriptConfig } from "@/lib/db";
import { hasEffectiveGrant } from "@/lib/grant-check";
import { broadcastEvent } from "@/lib/server-cache";
import { rejectNonHeadWrite } from "@/lib/head-version";
import type { ScriptConfig } from "@/lib/script-types";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";
import { isKnownTemplateId } from "@/lib/script-template";

export async function PUT(req: NextRequest, ctx: RouteContext<"/api/script/[id]/config">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档" }, { status: 403 });

  const nonHead = await rejectNonHeadWrite(id, req.nextUrl.searchParams.get("v"));
  if (nonHead) return nonHead;
  const versionId = req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id) ?? '';
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  const body = (await req.json()) as Partial<ScriptConfig>;
  const config: ScriptConfig = { ...DEFAULT_SCRIPT_CONFIG, ...body };
  // 模版 id 只认注册表里的预设（带版本）；null 合法 = 按 textLayoutMode 回退
  if (config.templateId !== null && !isKnownTemplateId(config.templateId)) {
    return Response.json({ error: "未知的排版模版" }, { status: 400 });
  }

  // 两把钥匙（客户端总是整份 config 发过来，按「哪些字段真变了」分门）：
  //   · 版式字段（pageLayout / textLayoutMode / templateId）= 改主本的排版
  //     → script_view/<主本>@edit（epic #337 §9），与编辑器「页面类型」菜单、打印页模版菜单同键
  //   · 其余剧本设置（舞台指示分隔符、排练记号开关、开篇章节）→ 沿用 scene meta/name@edit
  const current = versionId ? (await loadProduction(id, versionId))?.state.config ?? null : null;
  const layoutChanged = !current
    || current.pageLayout !== config.pageLayout
    || current.textLayoutMode !== config.textLayoutMode
    || (current.templateId ?? null) !== (config.templateId ?? null);
  const otherChanged = !current
    || current.stageDelimOpen !== config.stageDelimOpen
    || current.stageDelimClose !== config.stageDelimClose
    || current.useRehearsalMarks !== config.useRehearsalMarks
    || current.showOpeningChapter !== config.showOpeningChapter
    || (current.openingChapterMarkerId ?? null) !== (config.openingChapterMarkerId ?? null);
  if (layoutChanged) {
    const masterViewId = await getMasterScriptViewId(id);
    if (!await hasEffectiveGrant(permCtx, id, "script_view", masterViewId ?? "*", "*", "edit")) {
      return Response.json({ error: "无权修改剧本排版" }, { status: 403 });
    }
  }
  if (otherChanged && !await hasEffectiveGrant(permCtx, id, "scene", "*", "meta/name", "edit")) {
    return Response.json({ error: "无权修改剧本设置" }, { status: 403 });
  }
  if (!config.useRehearsalMarks && versionId) {
    const rehearsalMarkerLabel = await getFirstRehearsalMarkerLabel(versionId);
    if (rehearsalMarkerLabel) {
      return Response.json({
        error: `无法禁用，当前剧本存在排练记号 ${rehearsalMarkerLabel}`,
        rehearsalMarkerLabel,
      }, { status: 409 });
    }
  }

  await saveScriptConfig(id, versionId || null, config);
  // Broadcast config change to all connected SSE clients for this version
  broadcastEvent(id, versionId, "config", config);

  return Response.json({ ok: true });
}
