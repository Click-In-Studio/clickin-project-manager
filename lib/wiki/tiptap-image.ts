// wiki 图片节点 —— markdown 正史形态 ![alt](/__cm__/asset/<id>)：
// 正文只存 asset id 不存 URL（账本 §4.1 同款纪律——URL 是会过期的展示态，
// id 才是引用）。编辑器内展示经 resolveSrc 把私有 href 换成真实端点
// （thumb 流式带 session 鉴权，img src 直接可用）；attrs.src 恒存原始形态，
// 序列化按 attrs 走自带的 serializer（见 addStorage），roundtrip 无损。
// **全站注册**，不再按 imageUpload 门控。「一切文本皆文档」之后所有面都存
// markdown，而不认识 image 节点 = schema 直接把图片吃掉：实测
// `甲\n\n![说明](…)\n\n乙` 在没有本扩展的面上序列化回来只剩 `甲\n\n乙`，
// 整段没了，而那些面还没有保真锁兜底。能不能**新增**图片仍由 imageUpload
// 决定（上传器、粘贴占位都还挂在它上面），这里管的只是"认不认得"。
import { Node, mergeAttributes } from "@tiptap/core";

export type WikiImageOptions = {
  /** 把存储形态 src（/__cm__/asset/<id> 或普通 URL）换算成展示 URL */
  resolveSrc: (src: string) => string;
};

export const WikiImage = Node.create<WikiImageOptions>({
  name: "image",
  group: "block",
  draggable: true,

  addOptions() {
    return { resolveSrc: (src: string) => src };
  },

  addAttributes() {
    return {
      // 展示态 URL 回流（编辑器内复制粘贴自身内容）时经 data-cm-src 还原存储形态
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-cm-src") ?? el.getAttribute("src"),
      },
      alt: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  addStorage() {
    return {
      markdown: {
        /**
         * 必须自己写，不能用 prosemirror-markdown 的内建 image serializer——
         * 那个是给**行内**图片准备的，只 write 不 closeBlock。而本节点是
         * block，于是图片后面紧跟的段落会被并进同一段：
         *     甲\n\n![说明](x)\n\n乙  →  甲\n\n![说明](x)乙
         * 文字一个没少，所以保真锁（比内容签名）也发现不了，属于静默改结构。
         */
        serialize(
          state: { write: (s: string) => void; esc: (s: string) => string; closeBlock: (n: unknown) => void },
          node: { attrs: { src: string | null; alt: string | null; title: string | null } },
        ) {
          const { src, alt, title } = node.attrs;
          const url = (src ?? "").replace(/[()]/g, c => `\\${c}`);
          state.write(`![${state.esc(alt ?? "")}](${url}${title ? ` "${state.esc(title)}"` : ""})`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const src = (node.attrs.src as string | null) ?? "";
    return ["img", mergeAttributes(HTMLAttributes, {
      src: this.options.resolveSrc(src),
      "data-cm-src": src,
      class: "wiki-image",
    })];
  },
});
