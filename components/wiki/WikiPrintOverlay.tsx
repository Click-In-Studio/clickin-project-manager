"use client";

// wiki 文档打印页（导出 PDF = 浏览器打印，参考 MindWeave 文档打印页）：
// portal 到 body，@media print 下 body:has(.wiki-print-root) 隐藏其余子树
//（globals.css，与剧本 PrintPreview 同机制）。屏幕态是全屏预览 + 工具条。

import { createPortal } from "react-dom";
import { fmtDateTime } from "@/lib/tz";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";

export default function WikiPrintOverlay({
  productionId,
  productionName,
  title,
  body,
  updatedAt,
  onClose,
}: {
  productionId: string;
  productionName?: string;
  title: string;
  body: string;
  updatedAt: string;
  onClose: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="wiki-print-root fixed inset-0 z-[80] overflow-y-auto bg-white">
      {/* wiki 文档没有版式概念，固定 A4。globals.css 不再兜底 @page size——
          纸张尺寸由各打印页自己声明（剧本按演出版式算，见 lib/script-page.ts）。 */}
      <style dangerouslySetInnerHTML={{ __html: "@page { size: A4 portrait; margin: 0; }" }} />
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-white/95 px-6 py-3 print:hidden">
        <p className="text-sm text-zinc-500">
          打印预览 — 用浏览器「打印」保存为 PDF
        </p>
        <div className="flex gap-2">
          <button type="button" style={SECONDARY_BTN} onClick={onClose}>关闭</button>
          <button type="button" style={PRIMARY_BTN} onClick={() => window.print()}>打印 / 保存 PDF</button>
        </div>
      </div>
      {/* @page margin 0（剧本打印全局规则），内容自带页边距 */}
      <div className="mx-auto max-w-[720px] px-10 py-12 print:px-[18mm] print:py-[16mm] print:max-w-none">
        <h1 className="text-2xl font-bold text-zinc-900">{title}</h1>
        <p className="mt-1 mb-8 text-xs text-zinc-400">
          {productionName ? `${productionName} · ` : ""}更新于 {fmtDateTime(updatedAt)}
        </p>
        <WikiMarkdown content={body} productionId={productionId} />
      </div>
    </div>,
    document.body,
  );
}
