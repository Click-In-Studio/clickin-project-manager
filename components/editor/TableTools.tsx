"use client";

// 表格外缘 —— 表格上沿与左沿的两条操作带（飞书同款）。
//
// 为什么是"外缘"而不是"复用表格外框"（Notion 的做法）：外框本来就要留给单元格
// 边界，把它同时当操作区，命中范围只有 1~2px，且和单元格的选中/调整语义纠缠。
// 独立外缘的命中区可以做够宽，也和分栏那条分割线是同一套视觉语言。
//
// 编辑单位与分栏同构：**表格的单位是行与列**。所以外缘上点一段 = 选中整行/
// 整列（CellSelection，表格域的原生选中态），随后的操作都作用于这个选中；
// 单元格内部则完全不给块级手柄（见 BlockHandle 的 scoreDragTarget）。
//
// 用 **portal + fixed 覆盖层**而不是 decoration：表格的 DOM 是 <table>，往里
// 塞 <div> 会被浏览器抬出去（HTML 解析规则），而 decoration 只能挂进内容流里。
// 覆盖层还顺带避开了 PM 的 DOMObserver——我们一个字节都不改编辑器的 DOM。

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import {
  findTable, tableSize, selectColumn, selectRow, selectTable,
  insertColumnAtBoundary, insertRowAtBoundary,
  COLUMN_ACTIONS, ROW_ACTIONS, TABLE_ACTIONS, type TableAction, type TableLoc,
} from "@/lib/table-ops";

/** 外缘带的厚度 */
const STRIP = 14;

type Geom = {
  pos: number;
  rect: DOMRect;
  /** 视口坐标，长度 = 列数 + 1 */
  colEdges: number[];
  /** 视口坐标，长度 = 行数 + 1 */
  rowEdges: number[];
};

/** 量一张表的几何。nodeDOM 给的是 TableView 的 .tableWrapper，真表在它里面 */
function measure(editor: Editor, pos: number): Geom | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "table") return null;
  const wrapper = editor.view.nodeDOM(pos) as HTMLElement | null;
  const table = wrapper?.querySelector?.("table") as HTMLTableElement | null;
  if (!table) return null;
  const rows = [...table.querySelectorAll(":scope > tbody > tr")] as HTMLElement[];
  if (rows.length === 0) return null;
  const firstCells = [...rows[0].children] as HTMLElement[];
  if (firstCells.length === 0) return null;

  const rect = table.getBoundingClientRect();
  const colEdges = [firstCells[0].getBoundingClientRect().left];
  for (const c of firstCells) colEdges.push(c.getBoundingClientRect().right);
  const rowEdges = [rows[0].getBoundingClientRect().top];
  for (const r of rows) rowEdges.push(r.getBoundingClientRect().bottom);
  return { pos, rect, colEdges, rowEdges };
}

/** 光标所在表格（用于"操作期间外缘不消失"） */
function selectionTablePos(editor: Editor): number | null {
  const t = findTable(editor);
  return t ? t.pos : null;
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

type MenuState = { actions: TableAction[]; x: number; y: number } | null;

export default function TableTools({ editor }: { editor: Editor | null }) {
  const [geom, setGeom] = useState<Geom | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const activeRef = useRef<number | null>(null);
  const overToolsRef = useRef(false);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = !!menu;

  const refresh = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    const pos = activeRef.current;
    setGeom(pos == null ? null : measure(editor, pos));
  }, [editor]);

  const setActive = useCallback((pos: number | null) => {
    if (activeRef.current === pos) return;
    activeRef.current = pos;
    if (pos == null) setMenu(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;

    const onMove = (e: MouseEvent) => {
      // 菜单开着时别换目标——用户正在对着某一行/列下命令
      if (menuOpenRef.current) return;
      const hit = tableAtCoords(editor, e.clientX, e.clientY);
      if (hit != null) setActive(hit);
    };
    const onLeave = () => {
      // 鼠标移到外缘条上时也会触发编辑器的 mouseleave（覆盖层在 body 上），
      // 所以要看 overTools；光标停在表里也保持显示
      if (overToolsRef.current || menuOpenRef.current) return;
      setActive(selectionTablePos(editor));
    };
    const onTx = () => {
      // 文档/选中变了：表格尺寸可能变了，几何要重量
      if (activeRef.current == null) setActive(selectionTablePos(editor));
      else refresh();
    };

    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("mouseleave", onLeave);
    editor.on("transaction", onTx);
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("mouseleave", onLeave);
      editor.off("transaction", onTx);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, [editor, refresh, setActive]);

  // 点外面收菜单
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".wiki-table-menu")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!editor || !geom) return null;

  const loc = (): TableLoc | null => {
    const node = editor.state.doc.nodeAt(geom.pos);
    return node && node.type.name === "table" ? { node, pos: geom.pos } : null;
  };

  const { rect, colEdges, rowEdges } = geom;
  const cols = colEdges.length - 1;
  const rows = rowEdges.length - 1;

  /** 外缘一段：选中整行/整列并弹操作菜单 */
  const onSegment = (kind: "col" | "row", index: number, e: React.MouseEvent) => {
    e.preventDefault();
    const t = loc();
    if (!t) return;
    const ok = kind === "col" ? selectColumn(editor, t, index) : selectRow(editor, t, index);
    if (!ok) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ actions: kind === "col" ? COLUMN_ACTIONS : ROW_ACTIONS, x: r.left, y: r.bottom + 4 });
  };

  const onAdd = (kind: "col" | "row", boundary: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const t = loc();
    if (!t) return;
    if (kind === "col") insertColumnAtBoundary(editor, t, boundary);
    else insertRowAtBoundary(editor, t, boundary);
  };

  const size = loc() ? tableSize(loc()!.node) : { rows, cols };

  return createPortal(
    <div
      className="wiki-table-tools"
      onMouseEnter={() => { overToolsRef.current = true; }}
      onMouseLeave={() => { overToolsRef.current = false; }}
    >
      {/* 左上角：整张表 */}
      <div
        className="wiki-table-corner"
        style={{ left: rect.left - STRIP, top: rect.top - STRIP, width: STRIP, height: STRIP }}
        title="选中整张表格"
        onMouseDown={e => {
          e.preventDefault();
          const t = loc();
          if (!t || !selectTable(editor, t)) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ actions: TABLE_ACTIONS, x: r.left, y: r.bottom + 4 });
        }}
      />

      {/* 上沿：一列一段 */}
      {Array.from({ length: cols }, (_, i) => (
        <div
          key={`c${i}`}
          className="wiki-table-strip wiki-table-strip-col"
          style={{
            left: colEdges[i], top: rect.top - STRIP,
            width: Math.max(0, colEdges[i + 1] - colEdges[i]), height: STRIP,
          }}
          title="选中整列"
          onMouseDown={e => onSegment("col", i, e)}
        />
      ))}

      {/* 左沿：一行一段 */}
      {Array.from({ length: rows }, (_, j) => (
        <div
          key={`r${j}`}
          className="wiki-table-strip wiki-table-strip-row"
          style={{
            left: rect.left - STRIP, top: rowEdges[j],
            width: STRIP, height: Math.max(0, rowEdges[j + 1] - rowEdges[j]),
          }}
          title="选中整行"
          onMouseDown={e => onSegment("row", j, e)}
        />
      ))}

      {/* 列边界的 ⊕：n 列有 n+1 条边界。表格不给拖宽度，但必须能加列 */}
      {colEdges.map((x, i) => (
        <button
          key={`ca${i}`}
          type="button"
          className="wiki-table-add"
          style={{ left: x, top: rect.top - STRIP - 9 }}
          title={i === 0 ? "在最左插入列" : i === size.cols ? "在最右插入列" : "在这里插入列"}
          onMouseDown={e => onAdd("col", i, e)}
        >＋</button>
      ))}

      {/* 行边界的 ⊕ */}
      {rowEdges.map((y, j) => (
        <button
          key={`ra${j}`}
          type="button"
          className="wiki-table-add"
          style={{ left: rect.left - STRIP - 9, top: y }}
          title={j === 0 ? "在最上插入行" : j === size.rows ? "在最下插入行" : "在这里插入行"}
          onMouseDown={e => onAdd("row", j, e)}
        >＋</button>
      ))}

      {menu && (
        <div className="wiki-table-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.actions.map(a => (
            <button
              key={a.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); a.run(editor); setMenu(null); }}
              className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                a.danger ? "text-red-600 hover:bg-red-50" : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >{a.label}</button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
