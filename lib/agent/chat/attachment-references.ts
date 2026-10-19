/** 助手正文中的附件引用。历史取数与聊天展示共用同一套完整片段判据。 */
export function attachmentReferences(text: string): { text: string; items: Array<{ id: string; alt: string; key: string }> } {
  const items: Array<{ id: string; alt: string; key: string }> = [];
  const cleaned = text.replace(/\[\[attachment:([a-z0-9_]+)(?:\|([^\]\r\n]{0,200}))?\]\]/gi, (_all, id: string, alt?: string) => {
    items.push({ id, alt: alt?.trim() ?? "", key: `${id}:${items.length}` });
    return "";
  });
  return { text: cleaned.trim(), items };
}
