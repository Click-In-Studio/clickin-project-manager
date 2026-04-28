import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "send_card",
  description: "向当前聊天发送一张飞书互动卡片，适合展示结构化信息、列表或带标题的内容。当需要向用户提问且答案是有限选项时（如是/否、多选一），应优先使用此技能附带按钮让用户点选，而非用 reply 直接问文字——按钮交互比等待用户自行输入更可靠、更清晰。有按钮时通常配合 wait_reply:true。",
  enabled: true,
  params: [
    { name: "title",   type: "string", description: "卡片标题栏文字", required: true },
    { name: "content", type: "string", description: "卡片正文，支持飞书 Markdown 语法", required: true },
    {
      name: "color",
      type: "string",
      description: "标题栏颜色，可选值：blue（默认）、green、red、yellow、orange、purple、indigo、wathet、turquoise、carmine、violet",
      required: false,
    },
    {
      name: "buttons",
      type: "Array<{label:string, value:string, type?:'primary'|'default'|'danger'}>",
      description: "可选按钮列表。label 为显示文字，value 为点击后传递给助手的语义值，type 为样式（默认 default）。有按钮时通常配合 wait_reply:true 使用。",
      required: false,
    },
  ],
};
