"use client";

// 引用 chip 悬浮条（#692）：鼠标停在正文里的引用 chip 上，chip 上方浮出一条
// 「打开 ｜ 转为嵌入」。
//
// 为什么是悬浮而不是点击：chip 点击已经是「打开」（原子节点的自然语义，飞书 /
// Notion 同款），再往点击上叠菜单会抢掉它。飞书的链接编辑面板、Notion 的
// mention 预览都挂在 hover 上。
//
// 各 kind 同一套项（lib/editor/editor-embed-switch 的 chipMenuItems）：wiki / 场次 /
// cue 的「转为嵌入」灰掉给原因，不消失。素材能不能嵌入要查一次 preview-url
// （embed-media broker 的同源判据），查回来之前也是灰的、原因写「正在查」。
//
// `/` `@` `#` `[[` 补全菜单打开时让位（hidden），与 TaskSyncMenu 同款。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { BASE_PATH } from "@/lib/base-path";
import { embedMediaKind } from "@/lib/asset/embed-media";
import type { ContentMentionAttrs } from "@/lib/editor/mention-types";
import { chipMenuItems, mentionToEmbedTx, type EmbedCheck } from "@/lib/editor/editor-embed-switch";
import { navigateToMention } from "@/lib/editor/mention-navigate";

type Target = { pos: number; attrs: ContentMentionAttrs; rect: DOMRect };

const CHIP_SELECTOR = 'span[data-type="contentMention"]';
const BAR_HEIGHT = 28;
/** 鼠标从 chip 挪到浮条要经过一段空白，给这点时间，不然浮条在半路就收了 */
const HIDE_DELAY = 180;

/** chip 的 DOM → 文档位置。按节点找 DOM 而不是 posAtDOM：原子节点没有内容位，
 *  posAtDOM 对它的语义不稳；descendants 一遍 O(n)，hover 事件只在换元素时触发 */
function findChipPos(editor: Editor, el: Element): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === "contentMention" && editor.view.nodeDOM(pos) === el) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

export default function MentionChipMenu({ editor, productionId, hidden = false }: {
  editor: Editor | null;
  productionId: string;
  /** 补全菜单等更高优先级的弹层在场时让位 */
  hidden?: boolean;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [checks, setChecks] = useState<Record<string, EmbedCheck>>({});
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const cancelHide = () => {
    if (hideTimer.current != null) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setTarget(null), HIDE_DELAY);
  };

  // ① 触发：hover 到 chip 上。挂在编辑器 DOM 上而不是 document——只关心正文里的 chip
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const chipOf = (t: EventTarget | null) =>
      (t instanceof Element ? t.closest(CHIP_SELECTOR) : null);
    const onOver = (e: MouseEvent) => {
      const el = chipOf(e.target);
      if (!el || !dom.contains(el) || !editor.isEditable) return;
      cancelHide();
      const pos = findChipPos(editor, el);
      const node = pos == null ? null : editor.state.doc.nodeAt(pos);
      if (pos == null || !node) return;
      setTarget({ pos, attrs: node.attrs as ContentMentionAttrs, rect: el.getBoundingClientRect() });
    };
    const onOut = (e: MouseEvent) => {
      const el = chipOf(e.target);
      if (!el) return;
      const to = e.relatedTarget;
      if (to instanceof Node && (el.contains(to) || barRef.current?.contains(to))) return;
      scheduleHide();
    };
    dom.addEventListener("mouseover", onOver);
    dom.addEventListener("mouseout", onOut);
    return () => {
      dom.removeEventListener("mouseover", onOver);
      dom.removeEventListener("mouseout", onOut);
      cancelHide();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // ② 失效：文档一变 pos 就不可信，滚动一下 rect 就不可信——都直接收起
  useEffect(() => {
    if (!editor) return;
    const hide = () => { cancelHide(); setTarget(null); };
    editor.on("update", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      editor.off("update", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [editor]);

  // ③ 素材能不能嵌入：查 preview-url，按 mime 过 embed-media broker。结果按 asset id
  //    缓存——同一颗 chip 来回 hover 不重复查
  useEffect(() => {
    if (!target || target.attrs.kind !== "asset") return;
    const id = target.attrs.id;
    if (checks[id]) return;
    setChecks(c => ({ ...c, [id]: "checking" }));
    void (async () => {
      let result: EmbedCheck = "failed";
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${id}/preview-url`);
        if (res.ok) {
          const data = await res.json() as { mimeType?: string | null };
          result = embedMediaKind(data.mimeType) ? "yes" : "no";
        } else if (res.status === 400) {
          result = "no"; // 「不支持预览」= 没有嵌入形态
        }
      } catch { /* 网络抖动：failed */ }
      setChecks(c => ({ ...c, [id]: result }));
    })();
  }, [target, checks, productionId]);

  if (!editor || !target || hidden) return null;

  const items = chipMenuItems(target.attrs.kind, checks[target.attrs.id] ?? "unknown");
  // 贴 chip 上方；chip 顶到视口顶时改放下方
  const above = target.rect.top - BAR_HEIGHT - 4;
  const top = above >= 8 ? above : target.rect.bottom + 4;
  const left = Math.max(8, target.rect.left);

  const run = (id: ChipAction) => {
    const { pos, attrs } = target;
    setTarget(null);
    if (id === "open") { void navigateToMention(productionId, attrs); return; }
    // 再核一次 pos 上还是这颗 chip（hover 与点击之间文档可能变了）
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "contentMention" || node.attrs.id !== attrs.id) return;
    const tr = mentionToEmbedTx(editor.state, pos);
    if (!tr) return;
    editor.view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  };

  return createPortal(
    <div
      ref={barRef}
      onMouseEnter={cancelHide}
      onMouseLeave={scheduleHide}
      style={{ position: "fixed", left, top, height: BAR_HEIGHT, zIndex: 9999 }}
      className="flex items-center gap-0.5 px-1 bg-white rounded-lg shadow-lg border border-zinc-100 text-[12px]"
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          // 灰化用 aria-disabled + title：disabled 的按钮不冒鼠标事件，原因读不到（§13.4）
          aria-disabled={!!item.disabledReason}
          title={item.disabledReason}
          // onMouseDown + preventDefault：不拦的话点击先让编辑器失焦
          onMouseDown={e => { e.preventDefault(); if (!item.disabledReason) run(item.id); }}
          className={`px-2 py-1 rounded whitespace-nowrap ${
            item.disabledReason ? "text-zinc-300 cursor-not-allowed" : "text-zinc-700 hover:bg-zinc-100"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

type ChipAction = ReturnType<typeof chipMenuItems>[number]["id"];
