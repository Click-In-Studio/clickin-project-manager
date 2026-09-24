// 行内样式方言的编辑器侧（#524）：字色 / 底色 / 下划线三个 mark。
// canonical 形态与理由见 lib/editor/inline-style-dialect.ts。
//
// 三条实测得出的纪律（tiptap-markdown 0.9.0，见 #674）：
//   · **priority 必须高于 bold / italic / strike**，让样式标签永远在最外层：
//     `<u>**乙**</u>` 能再解析（`>**乙` 满足 CommonMark 侧翼规则），
//     `**<u>乙</u>**` 在中文里不能（`甲**<` 的 `**` 后跟标点、前无空白，被当字面）。
//     外内顺序由 schema 里的 mark 次序决定，所以序列化是幂等的，不撞保真锁。
//   · **expelEnclosingWhitespace 必须关**：tiptap-markdown 的 trimInline 假定
//     定界符是静态字符串，会拿函数型 open 去做字符串运算，输出里出现
//     `function () { [native code] }`；开着它还会把定界符挪进相邻 mark 里毁字。
//     HTML 标签两侧带空格本来就合法，不需要外推。
//   · 序列化用自己的 open/close，**不用 tiptap-markdown 的 HTMLMark 兜底**：
//     兜底会把 mark 属性漏成 `color="red"` 非法属性（#379 复盘里点过名）。
//
// 解析走两条路：canonical 存储态经 markdown-it（html:true）变 DOM 后由 parseHTML
// 接住；编辑器自身 renderHTML 落 data-fg / data-bg / <u>，同样被 parseHTML 接住
// （复制粘贴、协作同步都走这条）。**parse 路径也校验颜色**：不在枚举里的值一律
// 不进 attrs（#379 的 CSS 注入教训——mark 的 style 串是拼进 DOM 的）。
import { Mark, mergeAttributes } from "@tiptap/core";
import {
  type TextBgColor, type TextFgColor,
  bgOpenTag, fgOpenTag, isTextBgColor, isTextFgColor,
  SPAN_CLOSE_TAG, U_CLOSE_TAG, U_OPEN_TAG,
} from "./inline-style-dialect";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textColor: {
      /** 设字色；「默认颜色」不是一个值，用 unsetTextColor 去壳 */
      setTextColor: (color: TextFgColor) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
    textBackground: {
      setTextBackground: (color: TextBgColor) => ReturnType;
      unsetTextBackground: () => ReturnType;
    };
  }
}

/** 样式 mark 的 priority：Link 是 1000，都要压过它与 StarterKit 的行内 mark（100）。
 *  底色最外、字色次之、下划线再次——这就是 canonical 的嵌套顺序。 */
export const INLINE_STYLE_PRIORITY = { textBackground: 1003, textColor: 1002, underline: 1001 } as const;

type MarkdownSerializeSpec = {
  open: string | ((state: unknown, mark: { attrs: Record<string, unknown> }) => string);
  close: string;
  mixable: boolean;
  expelEnclosingWhitespace: boolean;
};

function markdownStorage(serialize: MarkdownSerializeSpec) {
  return { markdown: { serialize, parse: { /* canonical 是 HTML，markdown-it 直接吐 DOM */ } } };
}

export const TextColor = Mark.create({
  name: "textColor",
  priority: INLINE_STYLE_PRIORITY.textColor,

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => (isTextFgColor(el.getAttribute("data-fg")) ? el.getAttribute("data-fg") : null),
        renderHTML: (attrs: { color?: string | null }) => (isTextFgColor(attrs.color) ? { "data-fg": attrs.color } : {}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: "span[data-fg]", getAttrs: (el) => (isTextFgColor((el as HTMLElement).getAttribute("data-fg")) ? null : false) },
      // canonical 存储态 `<span style="color:red">`；consuming:false 让同一个 span
      // 上若还有 background-color / text-decoration 也能被另外两个 mark 接住
      {
        style: "color",
        consuming: false,
        getAttrs: (value) => {
          const name = String(value).trim().toLowerCase();
          return isTextFgColor(name) ? { color: name } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextColor: (color) => ({ commands }) => (isTextFgColor(color) ? commands.setMark(this.name, { color }) : false),
      unsetTextColor: () => ({ commands }) => commands.unsetMark(this.name, { extendEmptyMarkRange: true }),
    };
  },

  addStorage() {
    return markdownStorage({
      open: (_state, mark) => fgOpenTag(mark.attrs.color as TextFgColor),
      close: SPAN_CLOSE_TAG,
      mixable: true,
      expelEnclosingWhitespace: false,
    });
  },
});

export const TextBackground = Mark.create({
  name: "textBackground",
  priority: INLINE_STYLE_PRIORITY.textBackground,

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => (isTextBgColor(el.getAttribute("data-bg")) ? el.getAttribute("data-bg") : null),
        renderHTML: (attrs: { color?: string | null }) => (isTextBgColor(attrs.color) ? { "data-bg": attrs.color } : {}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: "span[data-bg]", getAttrs: (el) => (isTextBgColor((el as HTMLElement).getAttribute("data-bg")) ? null : false) },
      {
        style: "background-color",
        consuming: false,
        getAttrs: (value) => {
          const name = String(value).trim().toLowerCase();
          return isTextBgColor(name) ? { color: name } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextBackground: (color) => ({ commands }) => (isTextBgColor(color) ? commands.setMark(this.name, { color }) : false),
      unsetTextBackground: () => ({ commands }) => commands.unsetMark(this.name, { extendEmptyMarkRange: true }),
    };
  },

  addStorage() {
    return markdownStorage({
      open: (_state, mark) => bgOpenTag(mark.attrs.color as TextBgColor),
      close: SPAN_CLOSE_TAG,
      mixable: true,
      expelEnclosingWhitespace: false,
    });
  },
});

/**
 * 下划线。StarterKit 自带的 Underline 要关掉（SmartTextarea `underline: false`）：
 * 它没有 markdown serializer，落到 HTMLMark 兜底且 priority 低于 bold，
 * `<strong><u>` 一序列化就是 `<**u>`（#674）。命令名与快捷键与官方一致
 * （toggleUnderline / ⌘U），类型声明沿用 starter-kit 带进来的那份。
 */
export const InlineUnderline = Mark.create({
  name: "underline",
  priority: INLINE_STYLE_PRIORITY.underline,

  parseHTML() {
    return [
      { tag: "u" },
      // 飞书 / Word 粘贴：text-decoration: underline 写在 span 上
      { style: "text-decoration", consuming: false, getAttrs: (v) => (String(v).includes("underline") ? {} : false) },
      { style: "text-decoration-line", consuming: false, getAttrs: (v) => (String(v).includes("underline") ? {} : false) },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["u", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setUnderline: () => ({ commands }) => commands.setMark(this.name),
      toggleUnderline: () => ({ commands }) => commands.toggleMark(this.name),
      unsetUnderline: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-u": () => this.editor.commands.toggleUnderline(),
      "Mod-U": () => this.editor.commands.toggleUnderline(),
    };
  },

  addStorage() {
    return markdownStorage({ open: U_OPEN_TAG, close: U_CLOSE_TAG, mixable: true, expelEnclosingWhitespace: false });
  },
});

/** 三个 mark 一起挂（顺序无所谓，priority 决定 schema 次序） */
export const INLINE_STYLE_EXTENSIONS = [TextBackground, TextColor, InlineUnderline];
