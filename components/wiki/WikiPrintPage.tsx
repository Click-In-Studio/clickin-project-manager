"use client";

/**
 * wiki 文档打印页（#335）：/production/[id]/wiki/[wikiId]/print
 *
 * wiki 打印是**对外分享的轻量出口**，不是排版目标——它不进分页引擎，
 * 内容是一条流，靠浏览器自己断页。所以水印不像剧本那样逐页内嵌，
 * 而是平铺在内容盒的背景上：盒子跨页断开时背景会在每一页重画，
 * 这正是「一条流也要页页有水印」的最省做法。
 */

import { useEffect } from "react";
import { useFontsSettled } from "@/components/print/use-fonts-settled";
import { useRouter } from "next/navigation";
import { fmtDateTime } from "@/lib/tz";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import { buildWatermarkTile } from "@/components/watermark-tile";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import { PRINT_PAGE_CSS_A4 } from "@/lib/print-css";

export default function WikiPrintPage({
  productionId,
  productionName,
  wikiId,
  title,
  body,
  updatedAt,
  watermarkText,
}: {
  productionId: string;
  productionName?: string;
  wikiId: string;
  title: string;
  body: string;
  updatedAt: string;
  /** 访问者水印文案（服务端下发）。null = 不打水印。 */
  watermarkText: string | null;
}) {
  const router = useRouter();
  const tile = watermarkText ? buildWatermarkTile(watermarkText) : null;

  // 与剧本打印页同一个就绪信号：字体全部就位才算好。wiki 没有分页测量，
  // 所以只等字体——但换行点仍然取决于字体，早一步出片就是回退字体的排版。
  // 用 useFontsSettled 而不是 fonts.ready：后者可能在正文触发字体下载之前就
  // 解析过了（见 hook 头注）。
  const fontsSettled = useFontsSettled();
  useEffect(() => {
    if (!fontsSettled) return;
    document.body.dataset.printReady = "1";
    return () => {
      delete document.body.dataset.printReady;
    };
  }, [fontsSettled]);

  return (
    <div className="wiki-print-root min-h-full bg-white">
      {/* wiki 没有页盒（一条流，浏览器自己断页），所以用纸张关键字而不是剧本那种
          px 页盒尺寸。两种形态都在 lib/print-css.ts 里，分工写在那儿。 */}
      <style dangerouslySetInnerHTML={{ __html: PRINT_PAGE_CSS_A4 }} />

      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-white/95 px-6 py-3 print:hidden">
        <p className="text-sm text-zinc-500">打印预览 — 用浏览器「打印」保存为 PDF</p>
        <div className="flex gap-2">
          <button
            type="button"
            style={SECONDARY_BTN}
            onClick={() => router.push(`/production/${productionId}/wiki/${wikiId}`)}
          >
            返回文档
          </button>
          <button type="button" style={PRIMARY_BTN} onClick={() => window.print()}>
            打印 / 保存 PDF
          </button>
        </div>
      </div>

      {/* 水印平铺在这一层：它是跨页断开的那个盒子，背景会在每一页重画。
          内边距放在内层，水印才能盖到页边距区域而不是只有正文栏。 */}
      <div
        className="mx-auto max-w-[794px] print:max-w-none"
        style={tile ? { backgroundImage: tile, backgroundRepeat: "repeat" } : undefined}
      >
        {/* @page margin 0（全局约定），页边距由内容自己带 */}
        <div className="px-10 py-12 print:px-[18mm] print:py-[16mm]">
          <h1 className="text-2xl font-bold text-zinc-900">{title}</h1>
          <p className="mt-1 mb-8 text-xs text-zinc-400">
            {productionName ? `${productionName} · ` : ""}更新于 {fmtDateTime(updatedAt)}
          </p>
          <WikiMarkdown content={body} productionId={productionId} />
        </div>
      </div>
    </div>
  );
}
