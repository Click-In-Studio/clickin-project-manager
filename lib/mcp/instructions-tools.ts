// agents.md 指令的 MCP 写工具实现（my.update_instructions /
// production.update_instructions）。两个都是非只读工具——插件 fail-closed
// 机制自动挂聊天栏确认卡（工具调用权限门原则①：有权限的敏感写走确认门）；
// 制作级在确认批准后仍由本函数重查权限（原则②：无权限一律拦截并明确
// 告知，确认卡不是权限判定的替身——「模板≠保证」纪律同款）。
//
// 刻意没有配套读工具：当前生效的指令每轮注入在 <clickin-instructions>
// 块里，模型本来就看得见；工具返回更新前的旧内容，误覆盖可凭它恢复。

import {
  INSTRUCTIONS_MAX_LEN,
  canEditProductionInstructions,
  getAgentInstructions,
  setAgentInstructions,
} from "@/lib/agent-instructions";

function overLength(content: string): string | null {
  if (content.length > INSTRUCTIONS_MAX_LEN) {
    return `内容过长（${content.length} 字符，上限 ${INSTRUCTIONS_MAX_LEN}）。请精简后重试。`;
  }
  return null;
}

/** 全量替换调用者本人的个人指令。 */
export async function updateMyInstructions(userId: string, content: string): Promise<string> {
  const tooLong = overLength(content);
  if (tooLong) return tooLong;
  const previous = await getAgentInstructions("user", userId);
  await setAgentInstructions("user", userId, content, userId);
  const cleared = !content.trim();
  return [
    cleared ? "✅ 已清空该用户的个人 AI 指令。" : "✅ 已更新该用户的个人 AI 指令（下一轮对话生效）。",
    previous ? `更新前的内容（如属误覆盖可据此恢复）：\n${previous}` : "（此前没有个人指令）",
  ].join("\n\n");
}

/** 全量替换当前制作的制作级指令——权限门在前（ai_instructions/*@edit）。 */
export async function updateProductionInstructions(
  userId: string,
  productionId: string,
  content: string,
): Promise<string> {
  const tooLong = overLength(content);
  if (tooLong) return tooLong;
  if (!(await canEditProductionInstructions(userId, productionId))) {
    // 原则②：无权限明确拒绝、不执行。不伪装成"内容有问题"。
    return (
      "⛔ 该用户没有编辑本制作 AI 指令的权限（权限点：ai_instructions/编辑，默认仅制作人持有），本次调用未执行。" +
      "请把想改的内容告诉制作人，由其在制作设置页修改，或向其申请该权限后再试。"
    );
  }
  const previous = await getAgentInstructions("production", productionId);
  await setAgentInstructions("production", productionId, content, userId);
  const cleared = !content.trim();
  return [
    cleared ? "✅ 已清空本制作的 AI 指令。" : "✅ 已更新本制作的 AI 指令（对全体成员的下一轮对话生效）。",
    previous ? `更新前的内容（如属误覆盖可据此恢复）：\n${previous}` : "（此前没有制作级指令）",
  ].join("\n\n");
}
