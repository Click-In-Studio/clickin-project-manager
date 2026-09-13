// 图片上传占位 —— ProseMirror widget decoration 定式（官方 upload 示例同款）。
// 为什么不用临时节点：wiki 有防抖自动保存 + 协作广播，任何进 schema 的
// 「上传中」节点都会被序列化进 markdown 正史并广播出去；decoration 纯展示、
// 永不序列化，位置随后续编辑经 tr.mapping 自动跟移，天然安全。
// 生命周期：粘贴即挂占位（用户立刻看到反馈，不会以为粘贴无效而反复贴）→
// 上传成功在占位处插真节点并撤占位 → 失败把占位翻成失败态、几秒后自动消失。
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type PlaceholderAction =
  | { add: { id: object; pos: number; name: string } }
  | { fail: { id: object } }
  | { remove: { id: object } };

export const uploadPlaceholderKey = new PluginKey<DecorationSet>("uploadPlaceholder");

function makeWidget(name: string, failed: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = failed ? "wiki-upload-placeholder wiki-upload-placeholder-failed" : "wiki-upload-placeholder";
  el.textContent = failed ? `⚠️ ${name} 上传失败` : `📤 ${name} 上传中…`;
  return el;
}

export const UploadPlaceholder = Extension.create({
  name: "uploadPlaceholder",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: uploadPlaceholderKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc);
            const action = tr.getMeta(uploadPlaceholderKey) as PlaceholderAction | undefined;
            if (!action) return set;
            if ("add" in action) {
              const deco = Decoration.widget(action.add.pos, () => makeWidget(action.add.name, false), {
                id: action.add.id, name: action.add.name, side: -1,
              });
              return set.add(tr.doc, [deco]);
            }
            const id = "fail" in action ? action.fail.id : action.remove.id;
            const found = set.find(undefined, undefined, spec => spec.id === id);
            // remove() 会改写传入数组——位置与 spec 必须在 remove 之前取出
            const from = found.length ? found[0].from : null;
            const name = found.length ? ((found[0].spec as { name?: string }).name ?? "图片") : "图片";
            set = set.remove(found);
            if ("fail" in action && from != null) {
              // 同位换成失败态 widget（几秒后由调用方 remove），别静默消失——
              // 静默消失＝又回到「粘了没反应」
              return set.add(tr.doc, [
                Decoration.widget(from, () => makeWidget(name, true), { id, name, side: -1 }),
              ]);
            }
            return set;
          },
        },
        props: {
          decorations(state) {
            return uploadPlaceholderKey.getState(state);
          },
        },
      }),
    ];
  },
});

/** 按 id 找占位当前位置（已被用户删除时返回 null——视为取消，不再插入） */
export function findUploadPlaceholder(state: EditorState, id: object): number | null {
  const set = uploadPlaceholderKey.getState(state);
  const found = set?.find(undefined, undefined, spec => spec.id === id) ?? [];
  return found.length ? found[0].from : null;
}
