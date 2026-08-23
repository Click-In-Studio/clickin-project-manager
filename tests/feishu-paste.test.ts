// @vitest-environment jsdom
// 飞书粘贴归一化单测。HTML 样本取自本地 probe 实测采样（人名已替换），
// 形态记录见 MindWeave《飞书复制粘贴调研》§6。
import { describe, it, expect } from "vitest";
import { isFeishuHtml, transformFeishuHtml, type FeishuMember } from "@/lib/feishu-paste";

const MEMBERS: FeishuMember[] = [
  { userId: "u-zhang", name: "张三" },
  { userId: "u-li-1", name: "李四" },
  { userId: "u-li-2", name: "李四" }, // 重名——不允许猜
];

function atUser(username: string): string {
  const payload = JSON.stringify({ userid: "7351704248868257795", username, avatar_url: "https://x/avatar" });
  return `<a data-lark-atuser="${payload.replace(/"/g, "&quot;")}">@${username}</a>`;
}

describe("isFeishuHtml", () => {
  it("认飞书文档 root 标记", () => {
    expect(isFeishuHtml('<div data-page-id="x" data-lark-html-role="root">…</div>')).toBe(true);
  });
  it("认电子表格块与 @提及属性", () => {
    expect(isFeishuHtml('<byte-sheet-html-origin data-id=""><table></table></byte-sheet-html-origin>')).toBe(true);
    expect(isFeishuHtml(atUser("张三"))).toBe(true);
  });
  it("普通 HTML 不认", () => {
    expect(isFeishuHtml("<p><strong>加粗</strong>与 <a href='https://x'>链接</a></p>")).toBe(false);
  });
});

describe("transformFeishuHtml", () => {
  it("剥除 ISV 占位块（暂时无法在飞书文档外展示此内容）", () => {
    const html = `<div data-lark-html-role="root"><span class="block-id-X block-type-ISV_BLOCK block-placeholder"><div class="j-block-container"><span class="block-paste-placeholder">暂时无法在飞书文档外展示此内容</span></div></span><p>正文</p></div>`;
    const out = transformFeishuHtml(html);
    expect(out).not.toContain("暂时无法在飞书文档外展示此内容");
    expect(out).toContain("正文");
  });

  it("代码块：拆内层 div、保留换行与语言类名", () => {
    const html = `<pre style="white-space:pre;"><code class="language-C++" data-lark-language="C++"><div>int main();\n\nint main() {\n    return flase;\n}</div></code></pre>`;
    const out = transformFeishuHtml(html);
    expect(out).toContain('class="language-C++"');
    expect(out).not.toMatch(/<code[^>]*><div>/);
    expect(out).toContain("int main();\n\nint main() {");
  });

  it("代码块：多个 div 行以换行拼接", () => {
    const html = `<pre><code class="language-js"><div>line1</div><div>line2</div></code></pre>`;
    const out = transformFeishuHtml(html);
    expect(out).toContain("line1\nline2");
  });

  it("checklist：li[data-list=check] 映射为 taskList/taskItem（未勾选）", () => {
    const html = `<ul start="1" class="list-check1"><li class="ace-line" data-list="check"><div>买菜</div></li><li class="ace-line" data-list="check"><div>做饭</div></li></ul>`;
    const out = transformFeishuHtml(html);
    expect(out).toContain('data-type="taskList"');
    expect(out.match(/data-type="taskItem"/g)).toHaveLength(2);
    expect(out.match(/data-checked="false"/g)).toHaveLength(2);
  });

  it("checklist：done/checked 词防御性识别为已勾选", () => {
    const html = `<ul class="list-check1"><li data-list="done"><div>已完成</div></li></ul>`;
    const out = transformFeishuHtml(html);
    expect(out).toContain('data-checked="true"');
  });

  it("普通有序/无序列表不受 checklist 映射影响", () => {
    const html = `<ol><li class="ace-line">甲</li><li class="ace-line">乙</li></ol>`;
    const out = transformFeishuHtml(html);
    expect(out).not.toContain("taskList");
    expect(out).toContain("<ol>");
  });

  it("@提及：username 唯一命中成员 → atMention 节点 HTML", () => {
    const out = transformFeishuHtml(`<p>${atUser("张三")}负责</p>`, { members: MEMBERS });
    expect(out).toContain('data-type="atMention"');
    expect(out).toContain('data-id="u-zhang"');
    expect(out).toContain('data-label="张三"');
    expect(out).toContain("@张三");
    expect(out).not.toContain("data-lark-atuser");
  });

  it("@提及：未命中成员 → 纯文本 @名字", () => {
    const out = transformFeishuHtml(`<p>${atUser("王五")}负责</p>`, { members: MEMBERS });
    expect(out).not.toContain("atMention");
    expect(out).toContain("@王五负责");
  });

  it("@提及：重名成员不猜，降级为纯文本", () => {
    const out = transformFeishuHtml(`<p>${atUser("李四")}</p>`, { members: MEMBERS });
    expect(out).not.toContain("atMention");
    expect(out).toContain("@李四");
  });

  it("@提及：属性损坏时用链接文本兜底", () => {
    const out = transformFeishuHtml(`<p><a data-lark-atuser="{broken">@张三</a></p>`, { members: MEMBERS });
    expect(out).toContain("@张三");
    expect(out).not.toContain("data-lark-atuser");
  });

  it("视频：降级为带文件名的文本占位", () => {
    const html = `<video data-lark-video-uri="drivetoken://Tc6ob3" data-lark-video-mime="video/mp4" data-lark-video-name="家.mp4"></video>`;
    const out = transformFeishuHtml(html);
    expect(out).not.toContain("<video");
    expect(out).toContain("[飞书视频：家.mp4]");
  });

  it("飞书文档图片（鉴权 URL）→ 带文件名/尺寸的占位文本", () => {
    const snapshot = { image: { name: "剧照.jpg", width: 864, height: 1080 } };
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const b64 = btoa(String.fromCharCode(...bytes));
    const html = `<div data-lark-html-role="root"><img src="https://x.feishu.cn/space/api/box/stream/download/asynccode/?code=abc" data-snapshot="${b64}"></div>`;
    const out = transformFeishuHtml(html);
    expect(out).not.toContain("<img");
    expect(out).toContain("剧照.jpg");
    expect(out).toContain("864×1080");
    expect(out).toContain("复制图片");
  });

  it("飞书图片无元数据 → 匿名占位；非飞书图片原样保留", () => {
    const out = transformFeishuHtml(`<div data-lark-html-role="root"><img src="https://y.feishu.cn/img/1"><img src="https://example.com/normal.png"></div>`);
    expect(out).toContain("[图片");
    expect(out).toContain('<img src="https://example.com/normal.png">');
  });

  it("标准结构（标题/表格/引用/加粗）原样保留", () => {
    const html = `<div data-lark-html-role="root"><h2 class="heading-2">标题</h2><table class="ace-table"><tbody><tr><td colspan="1" rowspan="1">格</td></tr></tbody></table><blockquote data-type="quote_container">引</blockquote><strong>粗</strong></div>`;
    const out = transformFeishuHtml(html);
    expect(out).toContain("<h2");
    expect(out).toContain("<table");
    expect(out).toContain("<blockquote");
    expect(out).toContain("<strong>粗</strong>");
  });
});
