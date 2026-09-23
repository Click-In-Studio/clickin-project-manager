"use client";

// 评论面板懒加载壳（#641 拆包 / #647 补加载态）：真面板那条线拖着整套 TipTap /
// ProseMirror 与 markdown 渲染器，不该挡在剧本首屏前面；但拆成 chunk 之后，
// 点开面板要先等这条线过网络，没有任何反馈就成了「点了没反应」。这层薄壳把
// 成本变回可见：
//   · 面板外壳（标题栏 / 上下条 / 关闭 / 块摘要）立刻画出来，内容区给加载提示；
//   · chunk 由 ScriptEditor 在首屏画完后空闲预热，多数情况点开即到，壳只兜底。
// 壳自己只依赖 SideBlockPanel，不碰编辑器那条线，否则懒加载就白做了。
import { Suspense, lazy } from "react";
import SideBlockPanel from "./SideBlockPanel";
import type { CommentsPanelProps } from "./CommentsPanel";

const importCommentsPanel = () => import("./CommentsPanel");

const CommentsPanel = lazy(importCommentsPanel);

/** 预热评论面板 chunk；重复调用由模块缓存去重，失败留给真正打开时再报。 */
export function preloadCommentsPanel() {
  void importCommentsPanel().catch(() => {});
}

export default function CommentsPanelLazy(props: CommentsPanelProps) {
  return (
    <Suspense
      fallback={
        <SideBlockPanel
          blockId={props.blockId}
          activePanel="comment"
          onPanelChange={props.onPanelChange}
          blockCaption={props.blockCaption}
          width={props.width}
          navigation={props.navigation}
          onClose={props.onClose}
        >
          {/* 提示位置与真面板的空态（「暂无评论」）同格，换上真内容时不跳版 */}
          <div className="relative z-10 flex-1 overflow-y-auto bg-white px-4 py-3">
            <p className="py-4 text-center text-xs text-zinc-400">加载中…</p>
          </div>
        </SideBlockPanel>
      }
    >
      <CommentsPanel {...props} />
    </Suspense>
  );
}
