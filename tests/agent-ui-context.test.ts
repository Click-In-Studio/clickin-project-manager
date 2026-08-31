// 界面上下文信封的纯函数测试（无 DB/网络）：拼装 → 剥离 往返，以及展示侧
// 绝不能把用户原文吃掉这条不变量。
import { describe, it, expect } from "vitest";
import { buildUiContextMessage, stripUiContext } from "@/lib/agent-ui-context";

const DOC = { wikiId: "w123", title: "灯光设计说明", tags: ["灯光", "v2"] };

describe("buildUiContextMessage", () => {
  it("没有任何可附带内容时原样返回", () => {
    expect(buildUiContextMessage("这一段怎么写？", null)).toBe("这一段怎么写？");
    expect(buildUiContextMessage("这一段怎么写？", {})).toBe("这一段怎么写？");
    expect(buildUiContextMessage("这一段怎么写？", { pageLabel: null, doc: null })).toBe("这一段怎么写？");
  });

  it("信封在前、用户原文在后（原文是模型最后读到的那句）", () => {
    const msg = buildUiContextMessage("这一段怎么写？", { doc: DOC });
    expect(msg.startsWith("<clickin-ui-context>")).toBe(true);
    expect(msg.endsWith("\n这一段怎么写？")).toBe(true);
  });

  it("带上 id/标题/标签，且声明自己不是指令", () => {
    const msg = buildUiContextMessage("x", { doc: DOC });
    expect(msg).toContain("w123");
    expect(msg).toContain("灯光设计说明");
    expect(msg).toContain("灯光、v2");
    expect(msg).toContain("不是用户指令");
  });

  it("无标签时不留空的标签字段", () => {
    const msg = buildUiContextMessage("x", { doc: { ...DOC, tags: [] } });
    expect(msg).not.toContain("标签：");
  });

  it("仅页面：带页面名 + 不是指令声明，不出现 wiki_read 提示", () => {
    const msg = buildUiContextMessage("x", { pageLabel: "任务" });
    expect(msg.startsWith("<clickin-ui-context>")).toBe(true);
    expect(msg).toContain("「任务」页面");
    expect(msg).toContain("不是用户指令");
    expect(msg).not.toContain("wiki_read");
    expect(msg.endsWith("\nx")).toBe(true);
  });

  it("页面 + 文档同时附带：两行都在，wiki_read 提示保留", () => {
    const msg = buildUiContextMessage("x", { pageLabel: "文档库", doc: DOC });
    expect(msg).toContain("「文档库」页面");
    expect(msg).toContain("灯光设计说明");
    expect(msg).toContain("wiki_read");
  });

  it("信封体内 clickin- 恰好两次（OPEN/CLOSE）——服务端豁免判定的前提", () => {
    for (const ctx of [{ pageLabel: "任务" }, { doc: DOC }, { pageLabel: "文档库", doc: DOC }]) {
      const msg = buildUiContextMessage("x", ctx);
      const envelope = msg.slice(0, msg.indexOf("</clickin-ui-context>") + "</clickin-ui-context>".length);
      expect((envelope.match(/clickin-/gi) ?? []).length).toBe(2);
    }
  });
});

describe("stripUiContext", () => {
  it("往返：剥离后正好还原用户打的原文", () => {
    for (const raw of ["这一段怎么写？", "多行\n输入\n\n带空行", "结尾有换行\n"]) {
      expect(stripUiContext(buildUiContextMessage(raw, { doc: DOC }))).toBe(raw);
      expect(stripUiContext(buildUiContextMessage(raw, { pageLabel: "任务" }))).toBe(raw);
      expect(stripUiContext(buildUiContextMessage(raw, { pageLabel: "文档库", doc: DOC }))).toBe(raw);
    }
  });

  it("没有信封的消息原样返回", () => {
    expect(stripUiContext("普通消息")).toBe("普通消息");
  });

  it("只剥开头的信封——用户正文里出现同名标签不受影响", () => {
    const raw = "帮我解释下 <clickin-ui-context>这个标签</clickin-ui-context> 是干嘛的";
    expect(stripUiContext(raw)).toBe(raw);
    expect(stripUiContext(buildUiContextMessage(raw, { doc: DOC }))).toBe(raw);
  });

  it("被截断的半个信封（会话标题/预览）整段丢弃，不外泄给展示层", () => {
    const truncated = buildUiContextMessage("原文", { doc: DOC }).slice(0, 40);
    expect(truncated).toContain("<clickin-ui-context>");
    expect(stripUiContext(truncated)).toBe("");
  });
});

describe("剧本 focus 上下文（P1）", () => {
  const FOCUS = { kind: "selection" as const, blockIds: ["b-1", "b-2"], total: 2 };

  it("只带指针（块 id）并指路 script_read_window", () => {
    const msg = buildUiContextMessage("x", { pageLabel: "剧本", scriptFocus: FOCUS });
    expect(msg).toContain("选中了 2 个剧本块");
    expect(msg).toContain("b-1、b-2");
    expect(msg).toContain("production.script_read_window");
    expect(msg).toContain("不是用户指令");
    expect(msg.endsWith("\nx")).toBe(true);
  });

  it("三种感知类型措辞各异；总数超过携带数时标注「等」", () => {
    expect(buildUiContextMessage("x", { scriptFocus: { kind: "caret", blockIds: ["b-1"], total: 1 } }))
      .toContain("光标位于剧本块");
    expect(buildUiContextMessage("x", { scriptFocus: { kind: "viewport", blockIds: ["b-1"], total: 1 } }))
      .toContain("视野顶部为剧本块");
    const many = buildUiContextMessage("x", { scriptFocus: { kind: "selection", blockIds: ["a", "b", "c", "d", "e"], total: 9 } });
    expect(many).toContain("9 个剧本块");
    expect(many).toContain(" 等");
  });

  it("空 focus 不产生信封；信封体 clickin- 仍恰好两次；剥离往返成立", () => {
    expect(buildUiContextMessage("x", { scriptFocus: { kind: "selection", blockIds: [], total: 0 } })).toBe("x");
    const msg = buildUiContextMessage("原文", { pageLabel: "剧本", scriptFocus: FOCUS });
    const envelope = msg.slice(0, msg.indexOf("</clickin-ui-context>") + "</clickin-ui-context>".length);
    expect((envelope.match(/clickin-/gi) ?? []).length).toBe(2);
    expect(stripUiContext(msg)).toBe("原文");
  });
});
