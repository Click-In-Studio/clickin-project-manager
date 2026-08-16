// 界面上下文信封的纯函数测试（无 DB/网络）：拼装 → 剥离 往返，以及展示侧
// 绝不能把用户原文吃掉这条不变量。
import { describe, it, expect } from "vitest";
import { buildUiContextMessage, stripUiContext } from "@/lib/agent-ui-context";

const DOC = { wikiId: "w123", title: "灯光设计说明", tags: ["灯光", "v2"] };

describe("buildUiContextMessage", () => {
  it("没有附带文档时原样返回", () => {
    expect(buildUiContextMessage("这一段怎么写？", null)).toBe("这一段怎么写？");
  });

  it("信封在前、用户原文在后（原文是模型最后读到的那句）", () => {
    const msg = buildUiContextMessage("这一段怎么写？", DOC);
    expect(msg.startsWith("<clickin-ui-context>")).toBe(true);
    expect(msg.endsWith("\n这一段怎么写？")).toBe(true);
  });

  it("带上 id/标题/标签，且声明自己不是指令", () => {
    const msg = buildUiContextMessage("x", DOC);
    expect(msg).toContain("w123");
    expect(msg).toContain("灯光设计说明");
    expect(msg).toContain("灯光、v2");
    expect(msg).toContain("不是用户指令");
  });

  it("无标签时不留空的标签字段", () => {
    const msg = buildUiContextMessage("x", { ...DOC, tags: [] });
    expect(msg).not.toContain("标签：");
  });
});

describe("stripUiContext", () => {
  it("往返：剥离后正好还原用户打的原文", () => {
    for (const raw of ["这一段怎么写？", "多行\n输入\n\n带空行", "结尾有换行\n"]) {
      expect(stripUiContext(buildUiContextMessage(raw, DOC))).toBe(raw);
    }
  });

  it("没有信封的消息原样返回", () => {
    expect(stripUiContext("普通消息")).toBe("普通消息");
  });

  it("只剥开头的信封——用户正文里出现同名标签不受影响", () => {
    const raw = "帮我解释下 <clickin-ui-context>这个标签</clickin-ui-context> 是干嘛的";
    expect(stripUiContext(raw)).toBe(raw);
    expect(stripUiContext(buildUiContextMessage(raw, DOC))).toBe(raw);
  });

  it("被截断的半个信封（会话标题/预览）整段丢弃，不外泄给展示层", () => {
    const truncated = buildUiContextMessage("原文", DOC).slice(0, 40);
    expect(truncated).toContain("<clickin-ui-context>");
    expect(stripUiContext(truncated)).toBe("");
  });
});
