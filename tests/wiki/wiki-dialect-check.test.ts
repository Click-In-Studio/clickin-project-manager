import { describe, it, expect } from "vitest";
import {
  extractDisplayTitles, restoreAndCheckBody, DEAD_LINK_LITERAL,
} from "@/lib/agent-tools/wiki-dialect-check";

// #333 T2 方言校验/反解的纯单元测试（零 DB——标题映射由调用方查库传入，
// 这里直接构造）。roundtrip 语境：wiki_read 把 id 链接换成 [[标题]] 显示形态
// 给模型看，写回时必须反解回 id 形态，否则链接边被打断。

const ID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ID_B = "0b6ab930-e2aa-4020-8334-d749d7be82a5";

describe("extractDisplayTitles", () => {
  it("collects [[标题]] outside code, dedupes, skips dead-link literal", () => {
    const body = [
      "见 [[世界观设定]] 与 [[角色表]]，重复引用 [[世界观设定]]。",
      `坏链 [[${DEAD_LINK_LITERAL}]] 不收。`,
      "```",
      "示例：[[代码块里的标题]] 不是真引用",
      "```",
      "行内码 `[[行内码标题]]` 同样跳过。",
    ].join("\n");
    expect(extractDisplayTitles(body).sort()).toEqual(["世界观设定", "角色表"]);
  });
});

describe("restoreAndCheckBody：[[标题]] 反解", () => {
  it("唯一同名 → 反解为 id 链接形态", () => {
    const r = restoreAndCheckBody("参考 [[世界观设定]]。", new Map([["世界观设定", [ID_A]]]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toBe(`参考 [#](/__cm__/wiki/${ID_A})。`);
      expect(r.restoredCount).toBe(1);
    }
  });

  it("代码块里的 [[标题]] 原样保留（语法示例不是引用）", () => {
    const body = "```\n[[世界观设定]]\n```\n正文 [[世界观设定]]";
    const r = restoreAndCheckBody(body, new Map([["世界观设定", [ID_A]]]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toContain("```\n[[世界观设定]]\n```");
      expect(r.body).toContain(`[#](/__cm__/wiki/${ID_A})`);
    }
  });

  it("死链占位原样放行（显示转换已丢失原始 id，无从恢复）", () => {
    const r = restoreAndCheckBody(`旧引用 [[${DEAD_LINK_LITERAL}]] 保留。`, new Map());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toContain(`[[${DEAD_LINK_LITERAL}]]`);
  });

  it("未知标题 → 拒绝并指引用 id 形态", () => {
    const r = restoreAndCheckBody("见 [[模型新造的标题]]。", new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("没有这个标题");
  });

  it("同名多篇 → 拒绝并列出候选 id", () => {
    const r = restoreAndCheckBody("见 [[排练笔记]]。", new Map([["排练笔记", [ID_A, ID_B]]]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0]).toContain("2 篇同名");
      expect(r.problems[0]).toContain(ID_A);
      expect(r.problems[0]).toContain(ID_B);
    }
  });
});

describe("restoreAndCheckBody：退役形态", () => {
  it("裸 token [#wiki:uuid] → 拒绝", () => {
    const r = restoreAndCheckBody(`旧形态 [#wiki:${ID_A}]`, new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.includes("裸 token"))).toBe(true);
  });

  it("冒号形态 ](/__cm__wiki:id) → 拒绝", () => {
    const r = restoreAndCheckBody(`[#](/__cm__wiki:${ID_A})`, new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.includes("冒号形态"))).toBe(true);
  });

  it("代码块里的退役形态是语法示例 → 放行", () => {
    const r = restoreAndCheckBody(`\`\`\`\n[#wiki:${ID_A}]\n\`\`\``, new Map());
    expect(r.ok).toBe(true);
  });

  it("现行 id 链接形态 → 放行", () => {
    const r = restoreAndCheckBody(`见 [#](/__cm__/wiki/${ID_A})，@提及 [@某人](/__cm__/user/${ID_B})。`, new Map());
    expect(r.ok).toBe(true);
  });
});

describe("restoreAndCheckBody：块锚点消失（update）", () => {
  const OLD = "第一段 ^ab12\n第二段 ^cd34\n第三段（无锚点）";

  it("锚点全保留 → 通过", () => {
    const r = restoreAndCheckBody("第一段改写 ^ab12\n第二段 ^cd34\n新增一段", new Map(), OLD);
    expect(r.ok).toBe(true);
  });

  it("丢一个锚点 → 拒绝并点名", () => {
    const r = restoreAndCheckBody("第一段改写 ^ab12\n第二段被整段删了", new Map(), OLD);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.some((p) => p.includes("^cd34"))).toBe(true);
      expect(r.problems.some((p) => p.includes("^ab12"))).toBe(false);
    }
  });

  it("旧正文无锚点（当前线上常态：锚点尚未发放）→ 恒通过", () => {
    const r = restoreAndCheckBody("随便改写", new Map(), "旧正文没有任何锚点");
    expect(r.ok).toBe(true);
  });

  it("create（无 oldBody）不做锚点检查", () => {
    const r = restoreAndCheckBody("新文档正文", new Map(), null);
    expect(r.ok).toBe(true);
  });
});
