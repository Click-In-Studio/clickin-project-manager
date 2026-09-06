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

/** 嵌入形态判定结果（embed-media broker 的编辑器侧投影）：media 三态出原生
 *  元素，card=无嵌入形态/取不到（长尾类型降级文件卡片），null=非 asset src
 *  （外链图等）走裸 img。 */
export type WikiEmbedMeta =
  | { kind: "video" | "audio"; url: string }
  | { kind: "card" }
  | null;

export type WikiImageOptions = {
  /** 把存储形态 src（/__cm__/asset/<id> 或普通 URL）换算成展示 URL */
  resolveSrc: (src: string) => string;
  /** 异步取嵌入形态（查 preview-url + embed-media broker）。不提供＝一律 img
   *  （非 wiki 面没有 productionId 上下文时的兜底）。 */
  resolveMeta?: (src: string) => Promise<WikiEmbedMeta>;
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

  // nodeView 只管**编辑器内的活渲染**（video/audio/长尾卡片也要在编辑态所见
  // 即所得）；剪贴板/序列化仍走上面的 renderHTML/serializer——img+data-cm-src
  // 的 roundtrip 契约不因 nodeView 改变。
  addNodeView() {
    return ({ node }) => {
      const src = (node.attrs.src as string | null) ?? "";
      const alt = (node.attrs.alt as string | null) ?? "";
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      let dead = false;

      const img = document.createElement("img");
      img.src = this.options.resolveSrc(src);
      img.alt = alt;
      img.className = "wiki-image";
      dom.appendChild(img);

      const swap = (el: HTMLElement) => { dom.replaceChildren(el); };
      const card = () => {
        const s = document.createElement("span");
        s.className = "inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-200 bg-zinc-50 text-[12px] text-zinc-600";
        s.textContent = `▤ ${alt || "附件"}`;
        swap(s);
      };
      // thumb 流不出来（音频无缩略图/无权限）在 resolveMeta 到位前先降卡片，
      // 不给作者看裂图标；resolveMeta 回来若是 media 形态会再换回去
      img.onerror = () => { if (!dead && dom.contains(img)) card(); };

      void this.options.resolveMeta?.(src).then((meta) => {
        if (dead || !meta) return;
        if (meta.kind === "card") { card(); return; }
        const el = document.createElement(meta.kind);
        el.controls = true;
        el.preload = "metadata";
        el.src = meta.url;
        if (meta.kind === "video") { (el as HTMLVideoElement).poster = img.src; el.className = "wiki-image"; }
        else el.className = "wiki-audio";
        swap(el);
      }).catch(() => {});

      return {
        dom,
        // 播放器控件的指针/键盘事件不进 PM（否则点进度条变成选中节点）
        stopEvent: (e: Event) => e.target instanceof HTMLElement && !!e.target.closest("video, audio"),
        update: (n) => n.type === node.type && n.attrs.src === src && n.attrs.alt === alt,
        destroy: () => { dead = true; },
      };
    };
  },
});
