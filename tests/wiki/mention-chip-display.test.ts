// 引用 chip 的显示层（#689）：降级文案 + 标签拼装的纯函数，外加「没有哪个渲染点
// 会退回内部 kind 名」的静态棘轮。
//
// 为什么要静态棘轮：#689 的病因不是某一处写错，而是**三个渲染点各自**写了
// `?? kind` / `?? attrs.kind` / `${entityType}:${id}` 的兜底——正文里的显示位
// 哨兵化之后（语法大纲 G4）这三条兜底全部变成常态路径，读者看到的是 `#block`。
// 兜底写法本身是自然而然会被重新发明的，所以钉在源码上。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  MENTION_KIND_LABEL, MENTION_SENTINEL, mentionChipView, wikiChipView,
  mentionSummary, blockMentionLabel, blockMentionDetail, sceneMentionLabel,
} from "@/lib/editor/mention-display";
import { CONTENT_MENTION_KINDS } from "@/lib/editor/mention-types";

describe("类别名覆盖全部 kind", () => {
  it("每个 CONTENT_MENTION_KINDS 都有中文类别名，没有漏网的 kind 会显示成英文", () => {
    for (const kind of CONTENT_MENTION_KINDS) {
      const name = MENTION_KIND_LABEL[kind];
      expect(name, `kind=${kind} 没登记类别名`).toBeTruthy();
      // 「Cue」是剧组自己的词，不强求纯中文；只钉「不是 kind 标识符本身」
      expect(name).not.toBe(kind);
    }
  });
});

describe("mentionChipView 降级态", () => {
  it("未解析 / 解析失败 分得开，都不吐 kind 名", () => {
    const pending = mentionChipView("block", null);
    expect(pending.text).toBe("剧本片段…");
    expect(pending.muted).toBe(true);
    const failed = mentionChipView("block", null, null, true);
    expect(failed.text).toBe("剧本片段·取不到");
    expect(failed.muted).toBe(true);
    expect(failed.title).toContain("刷新");
  });

  it("四枚哨兵都翻成「类别名·原因」并给出解释，muted 成立", () => {
    const cases: [string, string][] = [
      [MENTION_SENTINEL.deleted, "已删除"],
      [MENTION_SENTINEL.unknownVersion, "无剧本"],
      [MENTION_SENTINEL.noAccess, "无权查看"],
      [MENTION_SENTINEL.untitled, "无标题"],
    ];
    for (const [sentinel, suffix] of cases) {
      const view = mentionChipView("scene", sentinel);
      expect(view.text).toBe(`场次·${suffix}`);
      expect(view.muted).toBe(true);
      expect(view.title).toBeTruthy();
      expect(view.title).toContain("场次");
    }
  });

  it("活标签原样呈现、补齐 # 前缀，detail 进悬浮", () => {
    expect(mentionChipView("scene", "#0-1 开场").text).toBe("#0-1 开场");
    expect(mentionChipView("asset", "灯位图.pdf").text).toBe("#灯位图.pdf"); // asset 分支不自带 #
    const withDetail = mentionChipView("block", "#0-1-3 李明：你到底", "李明：你到底想干什么");
    expect(withDetail.muted).toBe(false);
    expect(withDetail.title).toContain("你到底想干什么");
  });

  /** #689 的核心护栏：任何输入下 chip 上都不许出现内部 kind 名。 */
  it("全 kind × 全降级态：chip 文案里不出现内部 kind 名", () => {
    const labels = [null, ...Object.values(MENTION_SENTINEL)];
    for (const kind of CONTENT_MENTION_KINDS) {
      for (const label of labels) {
        for (const failed of [false, true]) {
          const { text } = mentionChipView(kind, label, null, failed);
          expect(text, `kind=${kind} label=${label}`).not.toContain(kind);
        }
      }
    }
  });
});

describe("wikiChipView", () => {
  it("[[…]] 三态：解析中 / 失败 / 已删除，都不拿正文的字冒充标题", () => {
    expect(wikiChipView(null).text).toBe("[[…]]");
    expect(wikiChipView(null, true).text).toBe("[[获取失败]]");
    expect(wikiChipView(MENTION_SENTINEL.deleted).text).toBe("[[已删除的文档]]");
    expect(wikiChipView(MENTION_SENTINEL.untitled).text).toBe("[[无标题文档]]");
    for (const label of [null, ...Object.values(MENTION_SENTINEL)]) {
      expect(wikiChipView(label).muted).toBe(label !== MENTION_SENTINEL.untitled);
    }
    const live = wikiChipView("灯光设计稿");
    expect(live.text).toBe("[[灯光设计稿]]");
    expect(live.muted).toBe(false);
  });
});

describe("摘要与标签拼装", () => {
  it("mentionSummary：剥行内记号、压空白、按字数截断", () => {
    expect(mentionSummary("**加粗**的台词")).toBe("加粗的台词");
    expect(mentionSummary("上一行\n下一行")).toBe("上一行 下一行");
    expect(mentionSummary("一二三四五六七八九十十一")).toBe("一二三四五六七八九十…");
    expect(mentionSummary("你到底想让我说什么，我全讲完了")).toBe("你到底想让我说什么…"); // 切口的逗号吃掉
    expect(mentionSummary("一二三四五六七八九十")).toBe("一二三四五六七八九十"); // 恰好不截
    expect(mentionSummary("   ")).toBe("");
  });

  it("mentionSummary 按码点切，代理对不被切成半个字", () => {
    const emoji = "🎭".repeat(12);
    const out = mentionSummary(emoji);
    expect([...out]).toHaveLength(11); // 10 个 emoji + 省略号
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("�");
  });

  it("blockMentionLabel：坐标常在，角色名与摘要按有无拼", () => {
    expect(blockMentionLabel("0-1-3", "你到底想干什么", "李明")).toBe("#0-1-3 李明：你到底想干什么");
    expect(blockMentionLabel("0-1-3", "灯渐暗", null)).toBe("#0-1-3 灯渐暗");
    expect(blockMentionLabel("p.4-2", "", null)).toBe("#p.4-2"); // 空块只剩坐标
    expect(blockMentionLabel("p.4-2", "   ", "李明")).toBe("#p.4-2");
  });

  it("blockMentionDetail：整句进悬浮，空正文没有可补的", () => {
    expect(blockMentionDetail("你到底想干什么，说清楚", "李明")).toBe("李明：你到底想干什么，说清楚");
    expect(blockMentionDetail("", "李明")).toBeNull();
  });

  it("sceneMentionLabel：场名可缺，缺了只剩场号", () => {
    expect(sceneMentionLabel("0-1", "开场")).toBe("#0-1 开场");
    expect(sceneMentionLabel("0-1", null)).toBe("#0-1");
    expect(sceneMentionLabel("0-1", "  ")).toBe("#0-1");
  });
});

// ── 静态棘轮 ──────────────────────────────────────────────────────────────────

/** 三个渲染点 + 通知投影。加第四个渲染点就往这张表里加。 */
const RENDER_POINTS = [
  "components/editor/SmartTextarea.tsx",
  "components/wiki/WikiMarkdown.tsx",
  "components/wiki/WikiEntityRefs.tsx",
];

describe("渲染点不得退回内部 kind 名（#689 静态棘轮）", () => {
  it("每个渲染点都从 mention-display 取文案，没有自造的 kind 名兜底", () => {
    for (const rel of RENDER_POINTS) {
      const src = readFileSync(rel, "utf-8");
      expect(src, `${rel} 没接显示层`).toContain("@/lib/editor/mention-display");
      expect(src, `${rel} 文案不是从 chip 视图来的`).toMatch(/(mentionChipView|wikiChipView)\(/);
      // `?? kind` / `?? attrs.kind`：两条历史兜底的形状
      expect(src, `${rel} 又写了 kind 名兜底`).not.toMatch(/\?\?\s*(attrs\.)?kind\b/);
      // `${r.entityId.slice(0, 8)}`：关联面板拿截断 id 当文案的那条兜底
      expect(src, `${rel} 又拿裸 id 当文案`).not.toMatch(/entityId\.slice\(/);
    }
  });

  it("编辑态标签刷新不设 kind 白名单——剧本域被漏掉正是 #689 的病因", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf-8");
    expect(src).not.toContain("LIVE_LABEL_KINDS");
  });

  it("引用节点两面同一个：plain 专用变体不认 [#](/__cm__/…)，不许复活", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf-8");
    expect(src).not.toContain("PlainContentMentionExt");
  });
});
