// wiki 图片节点 —— markdown 正史形态 ![alt](/__cm__/asset/<id>)：
// 正文只存 asset id 不存 URL（账本 §4.1 同款纪律——URL 是会过期的展示态，
// id 才是引用）。编辑器内展示经 resolveSrc 把私有 href 换成真实端点
// （thumb 流式带 session 鉴权，img src 直接可用）；attrs.src 恒存原始形态，
// tiptap-markdown 的内建 image spec（prosemirror-markdown 默认 serializer）
// 按 attrs 序列化，roundtrip 无损。
// 仅 wiki 编辑器注册（SmartTextarea 按 imageUpload prop 门控）——其他
// markdown 面（活动纪要等）不解锁图片节点，行为不变。
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

  renderHTML({ node, HTMLAttributes }) {
    const src = (node.attrs.src as string | null) ?? "";
    return ["img", mergeAttributes(HTMLAttributes, {
      src: this.options.resolveSrc(src),
      "data-cm-src": src,
      class: "wiki-image",
    })];
  },
});
