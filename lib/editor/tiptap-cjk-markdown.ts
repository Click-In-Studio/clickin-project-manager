// 加粗 / 斜体 / 删除线嵌套且两侧紧贴中文时的往返修复（#674）。
//
// 两层根因，各治一层：
//
// ① **tiptap-markdown 0.9.0 的 trimInline 会挪定界符**：它给 expelEnclosingWhitespace
//    的 mark 记下定界符位置，渲染完后按 markdown-it 的侧翼规则逐字符把 `**` / `~~`
//    往里挪直到「能开合」。两个这样的 mark 嵌套且两侧无空格（中文正文的常态）时，
//    外层定界符会被挪进内层甚至挪过去，产出 `甲**~~乙~~~~丙`、吃掉「丙」。
//    这里**不关 expelEnclosingWhitespace**——它是同一个开关，prosemirror-markdown
//    自带的「首尾空白挪到定界符外」也读它，关掉后 `**乙 **丙` 会连加粗都丢。
//    改为绕开 tiptap-markdown 的 state 子类：用 prosemirror-markdown 原版
//    MarkdownSerializer 跑序列化，原生空白外推保留，定界符不再被挪。
//    tiptap-markdown 的子类除了这段 hack 只多一个 `inTable` 字段（hardBreak 与
//    表格节点在读），运行期赋值即可，见 serializeWithoutTrimInline。
//
// ② **CommonMark 侧翼规则对 CJK 不友好**：`甲**~~乙~~**丙` 里第一个 `**` 后面
//    紧跟标点 `~`、前面是「甲」，按规范不算 left-flanking，写得再对也解析不回来。
//    编辑器侧给 markdown-it 挂 markdown-it-cjk-friendly（它替换 inline State 的
//    scanDelims，加粗与 `~~` 一并覆盖）；只读侧 / 保真锁的 remark 挂
//    REMARK_CJK_PLUGINS（lib/editor/remark-cjk-friendly.ts），**两侧必须同批**，
//    保真锁比的就是两侧。
//
// 已知限制：纯 ASCII 紧贴嵌套（`a**~~b~~**c`）在 CommonMark / GFM 下本来就无法
// 表示，CJK 规则只放宽 CJK 字周围，这种写法仍会 lossy——区别是保真锁会响，
// 不再静默毁字。本产品中文为主，作为已知限制记在 #674。
//
// 零 node 依赖，可进客户端包（SmartTextarea / components/ui/Markdown.tsx 都是 "use client"）。
import { Extension } from "@tiptap/core";
import type { Fragment, Node as PmNode } from "@tiptap/pm/model";
import { MarkdownSerializer } from "prosemirror-markdown";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import type MarkdownIt from "markdown-it";

/** tiptap-markdown 里 hardBreak 节点的名字（它构造 state 时传的就是这个） */
const HARD_BREAK_NODE_NAME = "hardBreak";

/** tiptap-markdown 存在 editor.storage.markdown 上的序列化器（未导出类型，只声明用到的） */
type TiptapMarkdownSerializer = {
  nodes: ConstructorParameters<typeof MarkdownSerializer>[0];
  marks: ConstructorParameters<typeof MarkdownSerializer>[1];
  serialize(content: PmNode | Fragment): string;
};

/**
 * 用 prosemirror-markdown 原版 serializer 跑；nodes / marks 仍取 tiptap-markdown
 * 按扩展聚合的那套。原版 state 没有 `inTable` 字段，但 table 节点是运行期赋值、
 * hardBreak 节点只做真值判断，缺省 undefined 与 false 同义，不用补子类。
 *
 * `content as PmNode`：serialize 的类型只收 Node，但 renderContent 只用
 * `parent.forEach`，Fragment 与 Node 都有；tiptap-markdown 自己的 serialize 就是
 * 这样把剪贴板切片（Fragment）喂进同一个 renderContent 的，它的 serializeHTML
 * 还显式处理了 `parent instanceof Fragment`。这里沿用同一契约，剪贴板用例盯着。
 */
export function serializeWithoutTrimInline(serializer: TiptapMarkdownSerializer, content: PmNode | Fragment): string {
  const plain = new MarkdownSerializer(serializer.nodes, serializer.marks, { hardBreakNodeName: HARD_BREAK_NODE_NAME });
  return plain.serialize(content as PmNode);
}

/** 已挂过 CJK 规则的 markdown-it 实例——parse.setup 每次 parse 都跑，不设防会层层套 State 子类 */
const cjkPatched = new WeakSet<MarkdownIt>();

/** 给 markdown-it 实例挂 CJK 侧翼规则，幂等 */
export function applyCjkFriendly(md: MarkdownIt): void {
  if (cjkPatched.has(md)) return;
  md.use(markdownItCjkFriendly);
  cjkPatched.add(md);
}

/**
 * 挂在 tiptap-markdown 的 Markdown 扩展旁边：解析侧接 CJK 侧翼规则，序列化侧
 * 绕开 trimInline。必须与 Markdown 扩展同在一个编辑器里，否则找不到
 * storage.markdown 会静默不生效（测试里有接线断言）。
 *
 * 替换点放 onBeforeCreate 而不是 onCreate：tiptap 的 `create` 事件是 setTimeout
 * 异步发出的，构造完同步调 getMarkdown（测试、以及任何「建完即读」的调用方）
 * 时 onCreate 还没跑。priority 压到 Markdown 扩展之下——它自己声明的是 50
 * （不是默认 100），同值按列表顺序稳定排序，所以必须严格更低——保证它的
 * onBeforeCreate 先建好 serializer 再轮到这里，与装配时的书写顺序无关。
 * 这是本文件最脆的不变量：测试里有一条静态护栏盯着 node_modules 里那个 50，
 * 升 tiptap-markdown 改了它会红；找不到 serializer 时这里静默不生效，也有
 * 用例直接断言替换已落到实例上。
 */
export const CjkMarkdown = Extension.create({
  name: "cjkMarkdown",
  priority: 40,

  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: MarkdownIt) { applyCjkFriendly(md); },
        },
      },
    };
  },

  onBeforeCreate() {
    const storage = (this.editor.storage as { markdown?: { serializer?: TiptapMarkdownSerializer } }).markdown;
    const serializer = storage?.serializer;
    if (!serializer) return;
    serializer.serialize = (content) => serializeWithoutTrimInline(serializer, content);
  },
});
