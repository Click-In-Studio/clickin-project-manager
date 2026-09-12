// 通知富文本的**平台接口**——通道之间唯一的共同语言。
//
// 管线：markdown → 通知 variant renderer（from-markdown.ts）→ 本 AST → 平台
// renderer（platform-*.ts）→ 发送。
//
// 为什么不直接把 markdown 源码丢给通道各自解析：那等于每接一个平台就要再实现
// 一遍 markdown 解析 + 我们的四类私有方言，通道的工作量线性增长，而且方言一改
// 就要同批改 N 个通道（「三落点纪律」会变成 N 落点）。AST 把"理解正文"这件事
// 收敛到一处，通道只负责"把 AST 摆成自己的格式"。
//
// 形状抄飞书卡片的 element 结构：飞书是我们的主通道，抄它意味着飞书渲染器几乎
// 是直传；其他平台（邮件可富、短信只能纯文本）各自降级。
//
// 降级纪律与方言的 G5 一致：**能富就富，不能富就拍平，但绝不吃字**。

export type DocInline =
  | { t: "text"; text: string; bold?: boolean; italic?: boolean; code?: boolean }
  /** 引用/外链统一成链接。text 是解析后的实时标签（正文里存的是 id）；
   *  url 对站内引用是**相对路径**，绝对化由平台 renderer 经 buildUrl 完成
   *  ——每个通道的可达地址不同（飞书用应用域、邮件用公开域），这是平台知识。 */
  | { t: "link"; text: string; url: string }
  /** @提及。userId 是内部 id，平台侧自行换算成自己的用户标识（飞书 open_id 等） */
  | { t: "at"; userId: string; name: string }
  | { t: "br" };

export type DocBlock =
  | { t: "p"; children: DocInline[] }
  | { t: "heading"; level: number; children: DocInline[] }
  | { t: "list"; ordered: boolean; items: DocInline[][] }
  | { t: "quote"; children: DocInline[] }
  | { t: "code"; lang: string | null; text: string }
  | { t: "divider" }
  /** 图片只带 id：URL 是会过期的展示态，由平台侧按自己的鉴权换算 */
  | { t: "image"; assetId: string; alt: string | null };

export type NotifyDoc = { blocks: DocBlock[] };

/** 引用解析器：把正文里的 id 引用换成可读标签 + 可点 URL。
 *  服务端注入——通知是在没有观看者会话的上下文里生成的，不能走前端那条
 *  逐观看者 resolve。解析不出来返回 null，渲染侧降级成中性文字，不吃字。 */
export type RefResolver = (ref: {
  type: string;
  id: string;
  params: URLSearchParams;
}) => Promise<{ label: string; url: string | null } | null>;

export const EMPTY_DOC: NotifyDoc = { blocks: [] };

/**
 * 按可见字符数截断，**不切开任何 inline 节点**。
 *
 * 为什么不能在渲染结果上 slice：卡片原来是拿裸 markdown 切 120 字，正好会把
 * `[#](/__cm__/wiki/<uuid>)` 拦腰截断，半截私有 href 直接漏进通知。在 AST 上
 * 截断则最坏情况只是少一个完整节点。
 */
export function truncateDoc(doc: NotifyDoc, maxChars: number): NotifyDoc {
  const len = (i: DocInline) =>
    i.t === "text" ? i.text.length : i.t === "link" ? i.text.length : i.t === "at" ? i.name.length + 1 : 1;

  let budget = maxChars;
  const blocks: DocBlock[] = [];
  let truncated = false;

  const take = (items: DocInline[]): DocInline[] => {
    const out: DocInline[] = [];
    for (const i of items) {
      const n = len(i);
      if (n > budget) { truncated = true; break; }
      budget -= n;
      out.push(i);
    }
    return out;
  };

  for (const b of doc.blocks) {
    if (budget <= 0) { truncated = true; break; }
    if (b.t === "p" || b.t === "heading" || b.t === "quote") {
      const kids = take(b.children);
      if (kids.length) blocks.push({ ...b, children: kids });
    } else if (b.t === "list") {
      const items = b.items.map(take).filter(it => it.length > 0);
      if (items.length) blocks.push({ ...b, items });
    } else if (b.t === "code") {
      if (b.text.length > budget) { truncated = true; break; }
      budget -= b.text.length;
      blocks.push(b);
    } else {
      blocks.push(b);
    }
    if (truncated) break;
  }

  if (truncated) blocks.push({ t: "p", children: [{ t: "text", text: "…" }] });
  return { blocks };
}
