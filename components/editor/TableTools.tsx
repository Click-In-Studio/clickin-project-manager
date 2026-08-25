"use client";

// 表格外缘 —— 表格上沿与左沿的两条操作带（飞书同款）。
//
// 为什么是"外缘"而不是"复用表格外框"（Notion 的做法）：外框本来就要留给单元格
// 边界，把它同时当操作区，命中范围只有 1~2px，且和单元格的选中语义纠缠。
//
// 编辑单位与分栏同构：**表格的单位是行与列**。外缘上点一段 = 选中整行/整列；
// 单元格内部完全不给块级手柄（见 lib/editor-drag-unit）。
//
// 两个定位上的决定：
//
// ① **挂进编辑器容器做 absolute，不用 fixed + 视口坐标。**
//    fixed 意味着每次滚动都要重算一遍坐标再 setState，注定慢一帧——实测就是
//    "滚动时明显延迟"。改成绝对定位在随内容一起滚的容器里，滚动时浏览器自己
//    搬运，一行 JS 都不跑。容器用 view.dom.parentElement（就是给块手柄做定位
//    基准的那层 .smart-textarea-shell）。
//
// ② **不用 <table> 内的 decoration**：表格 DOM 是 <table>，往里塞 <div> 会被
//    浏览器按 HTML 解析规则抬出去。覆盖层还顺带一个字节都不碰编辑器的 DOM。

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import {
  findTable, tableSize, selectColumn, selectRow, selectTable,
  insertColumnAtBoundary, insertRowAtBoundary,
  moveRow, moveColumn, hasMergedCells,
  type TableLoc,
} from "@/lib/table-ops";

/** 外缘带的厚度 */
const STRIP = 14;
/** 指针离某条边界多近才浮出它的 ⊕ */
const ADD_NEAR = 36;

/** 全部坐标都相对定位容器（.smart-textarea-shell），不是视口 */
type Geom = {
  pos: number;
  left: number; top: number; right: number; bottom: number;
  colEdges: number[];
  rowEdges: number[];
};

type Sel = { kind: "col" | "row"; index: number } | null;
type Near = { kind: "col" | "row"; index: number } | null;
/** 拖拽重排进行中：from = 被拖的行/列，to = 当前落点边界 */
type Drag = { kind: "col" | "row"; from: number; to: number } | null;

/** 落点边界：指针最靠近哪一条（0..n），与插入边界同一套编号 */
function boundaryAt(edges: number[], v: number): number {
  let best = 0;
  for (let i = 1; i < edges.length; i++) {
    if (Math.abs(v - edges[i]) < Math.abs(v - edges[best])) best = i;
  }
  return best;
}

function measure(editor: Editor, pos: number, host: HTMLElement): Geom | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "table") return null;
  const wrapper = editor.view.nodeDOM(pos) as HTMLElement | null;
  const table = wrapper?.querySelector?.("table") as HTMLTableElement | null;
  if (!table) return null;
  const rows = [...table.querySelectorAll(":scope > tbody > tr")] as HTMLElement[];
  if (rows.length === 0) return null;
  const cells = [...rows[0].children] as HTMLElement[];
  if (cells.length === 0) return null;

  const h = host.getBoundingClientRect();
  const t = table.getBoundingClientRect();
  const colEdges = [cells[0].getBoundingClientRect().left - h.left];
  for (const c of cells) colEdges.push(c.getBoundingClientRect().right - h.left);
  const rowEdges = [rows[0].getBoundingClientRect().top - h.top];
  for (const r of rows) rowEdges.push(r.getBoundingClientRect().bottom - h.top);
  return {
    pos,
    left: t.left - h.left, top: t.top - h.top,
    right: t.right - h.left, bottom: t.bottom - h.top,
    colEdges, rowEdges,
  };
}

/** 鼠标下的表格 */
function tableAtCoords(editor: Editor, x: number, y: number): number | null {
  const at = editor.view.posAtCoords({ left: x, top: y });
  if (!at) return null;
  const $pos = editor.state.doc.resolve(at.pos);
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === "table") return $pos.before(d);
  }
  return null;
}

/**
 * 指针虽然不在表格上、但已经进了**外缘该出现的那片区域**（表格的上方/左侧
 * 各 STRIP 那一条）时，也算命中。
 *
 * 少了这条就会陷入死循环式的手感：外缘只在鼠标压着表格时才出现，而外缘本身
 * 在表格外面——于是要摸到它，必须先进表格再往外挪，一旦挪出去它又没了。
 *
 * 用几何而不是 posAtCoords：那片区域压根不属于表格，posAtCoords 会把它解析
 * 到相邻的段落上。
 */
function tableNearPointer(editor: Editor, x: number, y: number): number | null {
  const pad = STRIP + 6;
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name !== "table") return true;
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    const r = dom?.getBoundingClientRect?.();
    if (r && x >= r.left - pad && x <= r.right && y >= r.top - pad && y <= r.bottom) {
      found = pos;
    }
    return false; // 表格不嵌套表格，不必再往下
  });
  return found;
}

/** 离指针最近、且够近的那条边界 —— 只浮出这一个 ⊕（Notion 同款） */
function nearestBoundary(geom: Geom, x: number, y: number): Near {
  const inTopBand = y <= geom.top + STRIP && y >= geom.top - STRIP * 3;
  const inLeftBand = x <= geom.left + STRIP && x >= geom.left - STRIP * 3;
  const pick = (edges: number[], v: number): number | null => {
    let best = 0;
    for (let i = 1; i < edges.length; i++) {
      if (Math.abs(v - edges[i]) < Math.abs(v - edges[best])) best = i;
    }
    return Math.abs(v - edges[best]) <= ADD_NEAR ? best : null;
  };
  if (inTopBand) {
    const i = pick(geom.colEdges, x);
    if (i != null) return { kind: "col", index: i };
  }
  if (inLeftBand) {
    const j = pick(geom.rowEdges, y);
    if (j != null) return { kind: "row", index: j };
  }
  return null;
}

export default function TableTools({ editor }: { editor: Editor | null }) {
  const [geom, setGeom] = useState<Geom | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [near, setNear] = useState<Near>(null);
  const [drag, setDrag] = useState<Drag>(null);
  // 拖拽落点的真相放 ref：mouseup 时要读它执行搬移，而 setState 的 updater
  // 必须保持纯函数，不能在里面做事
  const dragRef = useRef<Drag>(null);
  const activeRef = useRef<number | null>(null);
  const overToolsRef = useRef(false);
  const geomRef = useRef<Geom | null>(null);
  geomRef.current = geom;

  const host = editor && !editor.isDestroyed
    ? (editor.view.dom.parentElement as HTMLElement | null)
    : null;

  // 指针的最后位置（视口坐标）。refresh 要用它重算"最近的那条边界"——否则
  // 刚激活的那一帧 geom 还是空的，⊕ 要等下一次 mousemove 才肯出来
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const refresh = useCallback(() => {
    if (!editor || editor.isDestroyed || !host) return;
    const pos = activeRef.current;
    const g = pos == null ? null : measure(editor, pos, host);
    setGeom(g);
    if (!g) { setSel(null); setNear(null); return; }
    const p = pointerRef.current;
    if (!p) return;
    const h = host.getBoundingClientRect();
    setNear(nearestBoundary(g, p.x - h.left, p.y - h.top));
  }, [editor, host]);

  const setActive = useCallback((pos: number | null) => {
    if (activeRef.current === pos) return;
    activeRef.current = pos;
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !host) return;
    const dom = editor.view.dom;

    const onMove = (e: MouseEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
      // 三级命中：压在表上 → 已经进了外缘那片区域 → 光标正落在某张表里。
      // 都不中则**当场收起**：原先只在编辑器 mouseleave 时才收，于是鼠标移到
      // 别的段落上外缘还挂着不走，那就是"边框消失有明显延迟"
      const t = findTable(editor);
      const hit = tableAtCoords(editor, e.clientX, e.clientY)
        ?? tableNearPointer(editor, e.clientX, e.clientY)
        ?? (t ? t.pos : null);
      if (hit !== activeRef.current) { setActive(hit); return; } // setActive 内部会 refresh
      const g = geomRef.current;
      if (g) {
        const h = host.getBoundingClientRect();
        setNear(nearestBoundary(g, e.clientX - h.left, e.clientY - h.top));
      }
    };
    const onLeave = () => {
      if (overToolsRef.current) return;
      const t = findTable(editor);
      setActive(t ? t.pos : null);
      setNear(null);
    };
    const onTx = () => {
      const t = findTable(editor);
      if (activeRef.current == null && t) setActive(t.pos);
      else refresh();
      // 选中被别处改掉了（打字、点进单元格）→ 外缘上的高亮也该撤
      if (!(editor.state.selection.constructor.name === "CellSelection")) setSel(null);
    };

    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("mouseleave", onLeave);
    editor.on("transaction", onTx);
    // 只在 resize 时重量。滚动不需要——覆盖层挂在随内容滚动的容器里，
    // 浏览器自己搬运，这正是改用 absolute 的目的
    window.addEventListener("resize", refresh);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("mouseleave", onLeave);
      editor.off("transaction", onTx);
      window.removeEventListener("resize", refresh);
    };
  }, [editor, host, refresh, setActive]);

  if (!editor || !geom || !host) return null;

  const loc = (): TableLoc | null => {
    const node = editor.state.doc.nodeAt(geom.pos);
    return node && node.type.name === "table" ? { node, pos: geom.pos } : null;
  };
  const size = (() => { const t = loc(); return t ? tableSize(t.node) : null; })();
  if (!size) return null;

  const { colEdges, rowEdges } = geom;

  /**
   * 按下外缘一段：先选中，再挂上"可能是拖拽"的监听。
   *
   * 选中立即生效（点一下就是选中），拖拽要等指针真的移动超过阈值才认——否则
   * 每次点击都会被当成一次零距离的重排。
   */
  const onSegment = (kind: "col" | "row", index: number, e: React.MouseEvent) => {
    e.preventDefault();
    const t = loc();
    if (!t) return;
    const ok = kind === "col" ? selectColumn(editor, t, index) : selectRow(editor, t, index);
    if (!ok) return;
    setSel({ kind, index });
    if (hasMergedCells(t.node)) return; // 合并单元格的表不给重排，见 table-ops

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const onMove = (ev: MouseEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
      dragging = true;
      const g = geomRef.current;
      if (!g || !host) return;
      const h = host.getBoundingClientRect();
      const to = kind === "col"
        ? boundaryAt(g.colEdges, ev.clientX - h.left)
        : boundaryAt(g.rowEdges, ev.clientY - h.top);
      dragRef.current = { kind, from: index, to };
      setDrag(dragRef.current);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("wiki-table-reordering");
      // 落点从 **ref** 读，不从 setDrag 的 updater 里读：updater 必须是纯函数，
      // 在 React 的 StrictMode 下会被有意双调用——把搬移写在里面等于要么搬两次
      // 要么一次都不搬（这正是"拖拽 reorder 似乎没实现"的原因）
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      const tab = loc();
      if (cur && tab) {
        if (cur.kind === "col") moveColumn(editor, tab, cur.from, cur.to);
        else moveRow(editor, tab, cur.from, cur.to);
      }
      setSel(null); // 结构变了，旧的行列下标不再指向同一份内容
    };
    document.body.classList.add("wiki-table-reordering");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const onAdd = (kind: "col" | "row", boundary: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const t = loc();
    if (!t) return;
    if (kind === "col") insertColumnAtBoundary(editor, t, boundary);
    else insertRowAtBoundary(editor, t, boundary);
    setSel(null);
  };

  return createPortal(
    <div
      className="wiki-table-tools"
      onMouseEnter={() => { overToolsRef.current = true; }}
      onMouseLeave={() => { overToolsRef.current = false; setNear(null); }}
      onMouseMove={e => {
        pointerRef.current = { x: e.clientX, y: e.clientY };
        const h = host.getBoundingClientRect();
        setNear(nearestBoundary(geom, e.clientX - h.left, e.clientY - h.top));
      }}
    >
      {/* 左上角：选中整张表。不给菜单——整表的移动/复制/删除本来就在块手柄里 */}
      <div
        className="wiki-table-corner"
        style={{ left: geom.left - STRIP, top: geom.top - STRIP, width: STRIP, height: STRIP }}
        title="选中整张表格"
        onMouseDown={e => {
          e.preventDefault();
          const t = loc();
          if (t) { selectTable(editor, t); setSel(null); }
        }}
      />

      {/* 上沿：一列一段。点=选中该列；选中后那一段上浮出删除 */}
      {Array.from({ length: size.cols }, (_, i) => {
        const on = sel?.kind === "col" && sel.index === i;
        return (
          <div
            key={`c${i}`}
            className={`wiki-table-strip wiki-table-strip-col${on ? " is-on" : ""}`}
            style={{
              left: colEdges[i], top: geom.top - STRIP,
              width: Math.max(0, colEdges[i + 1] - colEdges[i]), height: STRIP,
            }}
            title="选中整列"
            onMouseDown={e => onSegment("col", i, e)}
          />
        );
      })}

      {/* 左沿：一行一段 */}
      {Array.from({ length: size.rows }, (_, j) => {
        const on = sel?.kind === "row" && sel.index === j;
        return (
          <div
            key={`r${j}`}
            className={`wiki-table-strip wiki-table-strip-row${on ? " is-on" : ""}`}
            style={{
              left: geom.left - STRIP, top: rowEdges[j],
              width: STRIP, height: Math.max(0, rowEdges[j + 1] - rowEdges[j]),
            }}
            title="选中整行"
            onMouseDown={e => onSegment("row", j, e)}
          />
        );
      })}

      {/* 拖拽重排的落点线（飞书同款：拖行/列时给一条实线指示落到哪） */}
      {drag && (
        drag.kind === "col" ? (
          <div className="wiki-table-dropline is-vertical"
            style={{ left: colEdges[drag.to] - 1, top: geom.top - STRIP, height: geom.bottom - geom.top + STRIP }} />
        ) : (
          <div className="wiki-table-dropline"
            style={{ left: geom.left - STRIP, top: rowEdges[drag.to] - 1, width: geom.right - geom.left + STRIP }} />
        )
      )}

      {/* ⊕ 只浮出指针最近的那一个 —— 全部常显会在表格上方挂满一排 */}
      {near?.kind === "col" && (
        <button
          type="button" className="wiki-table-add"
          style={{ left: colEdges[near.index], top: geom.top - STRIP - 9 }}
          title={near.index === 0 ? "在最左插入列" : near.index === size.cols ? "在最右插入列" : "在这里插入列"}
          onMouseDown={e => onAdd("col", near.index, e)}
        >＋</button>
      )}
      {near?.kind === "row" && (
        <button
          type="button" className="wiki-table-add"
          style={{ left: geom.left - STRIP - 9, top: rowEdges[near.index] }}
          title={near.index === 0 ? "在最上插入行" : near.index === size.rows ? "在最下插入行" : "在这里插入行"}
          onMouseDown={e => onAdd("row", near.index, e)}
        >＋</button>
      )}
    </div>,
    host,
  );
}
