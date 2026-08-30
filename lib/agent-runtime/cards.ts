// 确认卡片文案（#367 S2）：从 openclaw-plugins/clickin-memory 的 describeToolCall 移植，
// 逐字保留——前端零改动的一部分是用户看到的卡片一模一样。
// 网关的 description 上限 512 字符仍沿用（卡片本来就该短；全文在 agent_approval.args
// 与 wiki_proposal 里，预览 modal 按 toolCallId 拉）。

import type { ApprovalCard } from "./approvals";

const str = (v: unknown, cap: number): string =>
  typeof v === "string" ? (v.length > cap ? `${v.slice(0, cap)}…` : v) : String(v ?? "（无）");

const permLine = (verb: string, hasPermission?: boolean): string | null =>
  hasPermission === true
    ? `✅ 你有${verb}这篇文档的权限，批准后会直接生效。`
    : hasPermission === false
      ? `⛔ 你目前没有${verb}这篇文档的权限——批准后调用会被拦截、不会真的生效，转入审批流。`
      : null;

const lines = (parts: Array<string | null>) => parts.filter((l): l is string => l !== null).join("\n");

/** 构作族：权限三态由 previewDramaturgyProposal 算好放在 notes 里（一个写工具横跨多把钥匙，
 *  不能像 wiki 那样一句"这篇文档"概括），卡片只负责把它摆出来。 */
function dramaturgyLines(headline: string, items: string[], extra?: { hasPermission?: boolean; notes?: string[] }): string {
  const notes = extra?.notes ?? [];
  const blocked = notes.filter((n) => /^[🔓📝⛔]/u.test(n));
  const plain = notes.filter((n) => !/^[🔓📝⛔]/u.test(n));
  return lines([
    extra?.hasPermission === true ? "✅ 权限齐全，批准后直接生效。" : null,
    extra?.hasPermission === false ? "⛔ 缺少权限——批准后调用会被拦截、不会生效：" : null,
    ...blocked.map((n) => `  ${str(n, 140)}`),
    headline,
    ...(plain.length > 0 ? plain : items).slice(0, 6).map((n) => `• ${str(n, 100)}`),
    (plain.length > 0 ? plain : items).length > 6 ? `…共 ${(plain.length > 0 ? plain : items).length} 项` : null,
  ]);
}

const summaryLine = (params: Record<string, unknown>) => `📝 摘要：${str(params.summary, 100)}`;
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** bareTool = 去掉 clickin__ 前缀的暴露名（production-wiki_propose_create 等）。 */
export function approvalCard(bareTool: string, params: Record<string, unknown>, extra?: { hasPermission?: boolean; notes?: string[] }): ApprovalCard {
  const severity: ApprovalCard["severity"] = extra?.hasPermission === false ? "critical" : "warning";
  switch (bareTool) {
    case "production-scene_propose_update":
      return { severity, title: `提议修改 ${count(params.updates)} 个章节/场次的构作信息`, description: lines([
        dramaturgyLines("改动：", (Array.isArray(params.updates) ? params.updates : []).map((u: Record<string, unknown>) =>
          `${str(u.sceneId, 24)}：${Object.keys(u).filter((k) => k !== "sceneId").join("/")}`), extra),
        summaryLine(params),
      ]) };
    case "production-scene_propose_create":
      return { severity, title: `提议新建 ${count(params.items)} 个章节/场次`, description: lines([
        dramaturgyLines("新建：", (Array.isArray(params.items) ? params.items : []).map((i: Record<string, unknown>) => str(i.name, 40)), extra),
        summaryLine(params),
      ]) };
    case "production-scene_propose_delete":
      return { severity, title: `提议删除章节/场次（id: ${str(params.sceneId, 40)}）`, description: lines([
        dramaturgyLines("删除：", [str(params.sceneId, 40)], extra),
        summaryLine(params),
      ]) };
    case "production-character_propose_create":
      return { severity, title: `提议新建 ${count(params.items)} 个角色`, description: lines([
        dramaturgyLines("新建：", (Array.isArray(params.items) ? params.items : []).map((i: Record<string, unknown>) => str(i.name, 40)), extra),
        summaryLine(params),
      ]) };
    case "production-character_propose_update":
      return { severity, title: `提议修改 ${count(params.updates)} 个角色`, description: lines([
        dramaturgyLines("改动：", (Array.isArray(params.updates) ? params.updates : []).map((u: Record<string, unknown>) =>
          `${str(u.charId, 24)}：${Object.keys(u).filter((k) => k !== "charId").join("/")}`), extra),
        summaryLine(params),
      ]) };
    case "production-character_propose_delete":
      return { severity, title: `提议删除 ${count(params.charIds)} 个角色`, description: lines([
        dramaturgyLines("删除：", (Array.isArray(params.charIds) ? params.charIds : []).map((id: unknown) => str(id, 40)), extra),
        summaryLine(params),
      ]) };
    case "production-wiki_propose_create":
      return { severity, title: `提议新建文档：${str(params.title, 60)}`, description: lines([
        permLine("新建", extra?.hasPermission),
        `📄 标题：${str(params.title, 80)}`,
        params.parentId ? `📂 父文档 id：${str(params.parentId, 60)}` : "📂 位置：文档库根",
        `📝 摘要：${str(params.summary, 100)}`,
        `内容预览：`,
        str(params.body, 160),
      ]) };
    case "production-wiki_propose_update":
      return { severity, title: `提议修改文档（id: ${str(params.wikiId, 40)}）`, description: lines([
        permLine("编辑", extra?.hasPermission),
        params.title !== undefined ? `📄 新标题：${str(params.title, 80)}` : "📄 标题不变",
        `📝 摘要：${str(params.summary, 100)}`,
        params.body !== undefined ? `新正文预览：\n${str(params.body, 160)}` : "正文不变",
      ]) };
    case "production-wiki_propose_delete":
      return { severity, title: `提议删除文档（id: ${str(params.wikiId, 40)}）`, description: lines([
        permLine("删除", extra?.hasPermission),
        `📝 理由：${str(params.summary, 150)}`,
        "⚠️ 若目标被报告/备注引用（挂载）或是系统锚点目录，即使有权限也无法删除，这不是权限问题。",
      ]) };
    case "production-wiki_propose_move":
      return { severity, title: `提议移动文档（id: ${str(params.wikiId, 40)}）`, description: lines([
        permLine("编辑", extra?.hasPermission),
        params.newParentId ? `📂 新父文档 id：${str(params.newParentId, 60)}` : "📂 移到文档库根",
        `📝 理由：${str(params.summary, 150)}`,
      ]) };
    case "production-wiki_propose_tag": {
      const tagList = Array.isArray(params.tags) ? params.tags.join("、") : str(params.tags, 100);
      return { severity, title: `提议设置文档标签（id: ${str(params.wikiId, 40)}）`, description: lines([
        permLine("编辑", extra?.hasPermission),
        `🏷️ 新标签（整体替换）：${tagList || "（清空）"}`,
        `📝 理由：${str(params.summary, 100)}`,
      ]) };
    }
    case "production-wiki_set_grant": {
      const people = Array.isArray(params.addPeople)
        ? params.addPeople.map((p: unknown) => {
            const o = (p ?? {}) as { userId?: unknown; level?: unknown };
            return `${str(o.userId, 40)}（${str(o.level, 10)}）`;
          }).join("、")
        : "";
      const removed = Array.isArray(params.removePeopleUserIds) ? params.removePeopleUserIds.join("、") : "";
      const depts = Array.isArray(params.deptIds) ? params.deptIds : null;
      return { severity: "warning", title: `修改文档分享设置（id: ${str(params.wikiId, 40)}）`, description: lines([
        "🔐 这会改变谁能看见这篇文档。",
        params.isPublic === undefined ? null : params.isPublic ? "🌐 设为：制作全体成员可见" : "🌐 取消：全体成员可见",
        depts === null ? null : depts.length > 0 ? `🏢 部门分享（整体替换）：${str(depts.join("、"), 120)}` : "🏢 清空全部部门分享",
        people ? `👤 新增分享给：${str(people, 120)}` : null,
        removed ? `🚫 撤销分享：${str(removed, 120)}` : null,
        `📝 理由：${str(params.summary, 100)}`,
      ]) };
    }
    case "my-update_instructions":
      return { severity: "warning", title: "修改你的个人 AI 指令", description: lines([
        "✍️ AI 请求全量替换你的个人指令（只影响你自己的会话，下一轮生效）。",
        `新内容${typeof params.content === "string" && !params.content.trim() ? "：（清空）" : "预览："}`,
        str(params.content, 360),
      ]) };
    case "production-update_instructions":
      return { severity: "warning", title: "修改本制作的 AI 指令", description: lines([
        "✍️ AI 请求全量替换本制作的 AI 指令——对全体成员的 AI 会话生效。",
        "批准后若你没有编辑权限（默认仅制作人），调用会被拦截、不会生效。",
        `新内容${typeof params.content === "string" && !params.content.trim() ? "：（清空）" : "预览："}`,
        str(params.content, 300),
      ]) };
    case "users-query_sensitive":
      return { severity: "warning", title: "查询你的登记联系方式", description: "🔒 AI 请求读取你本人的敏感信息（邮箱/电话）。批准后仅返回给本会话。" };
    default:
      return { severity: "warning", title: `执行 ${bareTool}`, description: `参数：${str(JSON.stringify(params), 480)}` };
  }
}
