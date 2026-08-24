// 通知富文本管线：markdown → 通知 variant renderer → 通用 AST → 平台 renderer。
// 贯穿断言：**形态可以降级，字不能丢**（方言 G5 在通知侧的对应）。
import { describe, it, expect } from "vitest";
import { renderNotifyDoc } from "@/lib/notify-doc/from-markdown";
import { toFeishuElements, toLarkMd } from "@/lib/notify-doc/platform-feishu";
import { toPlainText, toSummary } from "@/lib/notify-doc/platform-text";
import { toEmailHtml } from "@/lib/notify-doc/platform-html";
import { truncateDoc, type RefResolver } from "@/lib/notify-doc/ast";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const resolver: RefResolver = async ({ type, id }) => {
  if (type === "wiki" && id === UUID) return { label: "世界观报告", url: "https://app.example.com/wiki/x" };
  if (type === "user") return { label: "张三", url: null };
  if (type === "cue") return { label: "LX.1", url: "https://app.example.com/cue/1" };
  return null; // 解析不出来的引用
};

async function doc(md: string) { return renderNotifyDoc(md, resolver); }

describe("引用解析（通知 variant 的核心差异）", () => {
  it("id 引用换成实时标签 + 绝对 URL", async () => {
    const d = await doc(`见 [#](/__cm__/wiki/${UUID}) 一节`);
    expect(toPlainText(d)).toBe("见 世界观报告（https://app.example.com/wiki/x） 一节");
  });

  it("@提及落成 at 节点，带 userId 供平台换算", async () => {
    const d = await doc("辛苦 [@张三](/__cm__/user/u_1) 跟进");
    const p = d.blocks[0];
    expect(p.t).toBe("p");
    expect(p.t === "p" && p.children.some(c => c.t === "at" && c.userId === "u_1")).toBe(true);
  });

  it("解析不出来的引用降级成中性文字——绝不把裸 id 或私有 href 漏给用户", async () => {
    const d = await doc("[#](/__cm__/scene/sc_gone) 这一场");
    const out = toPlainText(d);
    expect(out).not.toContain("__cm__");
    expect(out).not.toContain("sc_gone");
    expect(out).toContain("这一场");
  });

  it("普通外链原样保留", async () => {
    expect(toPlainText(await doc("[文档](https://x.com/a)"))).toBe("文档（https://x.com/a）");
  });
});

describe("方言降级", () => {
  it("callout → 引用块，emoji 并进首行，内容不丢", async () => {
    const d = await doc("> [!🍰 bg=#fff5eb]\n> 注意排期");
    expect(toPlainText(d)).toContain("🍰 注意排期");
  });

  it("分栏 fence 标记丢弃，栏内容顺序铺开", async () => {
    const d = await doc(":::cols 46,54\n\n左栏\n\n---\n\n右栏\n\n:::");
    const out = toPlainText(d);
    expect(out).toContain("左栏");
    expect(out).toContain("右栏");
    expect(out).not.toContain(":::");
  });

  it("表格拍成逐行段落，单元格不丢", async () => {
    const d = await doc("| A | B |\n|---|---|\n| 1 | 2 |");
    const out = toPlainText(d);
    expect(out).toContain("A · B");
    expect(out).toContain("1 · 2");
  });

  it("图片只留 assetId，不落会过期的 URL", async () => {
    const d = await doc("![剧照](/__cm__/asset/as_1)");
    expect(d.blocks[0]).toEqual({ t: "image", assetId: "as_1", alt: "剧照" });
  });
});

describe("飞书平台 renderer", () => {
  it("链接/粗体/列表落成 lark_md", async () => {
    const d = await doc(`**重点**：见 [#](/__cm__/wiki/${UUID})\n\n- 甲\n- 乙`);
    const md = toLarkMd(d);
    expect(md).toContain("**重点**");
    expect(md).toContain("[世界观报告](https://app.example.com/wiki/x)");
    expect(md).toContain("• 甲");
  });

  it("有 open_id 就落原生 <at>，没有就降级成 @姓名", async () => {
    const d = await doc("[@张三](/__cm__/user/u_1) 请看");
    expect(toLarkMd(d, { openIdByUserId: new Map([["u_1", "ou_abc"]]) })).toContain("<at id=ou_abc></at>");
    expect(toLarkMd(d)).toContain("@张三");
  });

  it("正文里的星号被转义，不会被当成 lark_md 的加粗标记", async () => {
    const d = await doc("预算 \\*不含\\* 税");
    expect(toLarkMd(d)).toContain("\\*不含\\*");
  });

  it("分隔线落成卡片原生 hr，文本块合并成 div", async () => {
    const els = toFeishuElements(await doc("上\n\n---\n\n下"));
    expect(els).toEqual([
      { tag: "div", text: { tag: "lark_md", content: "上" } },
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: "下" } },
    ]);
  });

  it("标题降级成粗体行（lark_md 没有标题）", async () => {
    expect(toLarkMd(await doc("## 排期变更"))).toBe("**排期变更**");
  });
});

describe("纯文本平台 renderer", () => {
  it("链接壳去掉但保留文字与 URL", async () => {
    expect(toPlainText(await doc("[#](/__cm__/cue/c1)"))).toBe("LX.1（https://app.example.com/cue/1）");
  });

  it("keepUrls=false 只留文字", async () => {
    expect(toPlainText(await doc("[#](/__cm__/cue/c1)"), { keepUrls: false })).toBe("LX.1");
  });

  it("摘要拍平换行并截断", async () => {
    const d = await doc(`# 标题\n\n${"字".repeat(200)}`);
    const s = toSummary(d, 20);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s.endsWith("…")).toBe(true);
  });

  it("空正文安全", async () => {
    expect(toPlainText(await doc("   "))).toBe("");
    expect(toFeishuElements(await doc(""))).toEqual([]);
  });
});

describe("AST 层截断（卡片预览的正确切法）", () => {
  it("不切开链接节点——半截私有 href 绝不能漏进通知", async () => {
    const d = await doc(`前言 [#](/__cm__/wiki/${UUID}) 后语`);
    const t = toPlainText(truncateDoc(d, 4), { keepUrls: false });
    expect(t).not.toContain("__cm__");
    expect(t).not.toContain("世界观"); // 整个链接节点放不下就整个丢掉
    expect(t).toContain("…");
  });

  it("放得下就完整保留", async () => {
    const d = await doc(`见 [#](/__cm__/wiki/${UUID})`);
    expect(toPlainText(truncateDoc(d, 100), { keepUrls: false })).toBe("见 世界观报告");
  });

  it("截断后追加省略号", async () => {
    const d = await doc("一二三四五六七八九十");
    expect(toPlainText(truncateDoc(d, 3))).toBe("…");
  });
});

describe("邮件平台 renderer（HTML）", () => {
  it("HTML 一律转义——正文里的尖括号/& 不能变成标签或实体注入", async () => {
    const d = await doc('风险 <script>alert(1)</script> 与 A&B');
    const html = toEmailHtml(d);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A&amp;B");
  });

  it("引用落成真链接，站内相对路径经 buildUrl 绝对化", async () => {
    const d = await doc(`见 [#](/__cm__/wiki/${UUID})`);
    const html = toEmailHtml(d, { buildUrl: p => `https://mail.example.com${p}` });
    expect(html).toContain('href="https://app.example.com/wiki/x"'); // 解析器给的绝对地址原样用
  });

  it("绝对化不了的站内路径只留文字，不给死链", async () => {
    const localResolver: RefResolver = async () => ({ label: "某文档", url: "/production/p1/wiki/w1" });
    const d = await renderNotifyDoc("[#](/__cm__/wiki/w1)", localResolver);
    const html = toEmailHtml(d); // 不传 buildUrl
    expect(html).not.toContain("<a ");
    expect(html).toContain("某文档");
  });

  it("富语义真的富起来：粗体/列表/引用块各有其标签", async () => {
    const html = toEmailHtml(await doc("**重点**\n\n- 甲\n\n> 提示"));
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<li");
    expect(html).toContain("border-left");
  });

  it("三个通道拿到的是同一份 AST 的不同投影", async () => {
    const d = await doc(`**A** [#](/__cm__/wiki/${UUID})`);
    expect(toLarkMd(d)).toContain("**A**");
    expect(toEmailHtml(d)).toContain("<strong>A</strong>");
    expect(toPlainText(d, { keepUrls: false })).toBe("A 世界观报告");
  });
});
