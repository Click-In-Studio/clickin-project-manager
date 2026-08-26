"use client";

/**
 * 打印路由的客户端外壳：数据由服务端取好传进来，这里只负责挂 PrintPreview
 * 并把「关闭」接回剧本页。
 *
 * 分页仍然是浏览器实测（逐块 offsetHeight），所以打印页必须是客户端组件——
 * 这不是可以省掉的一步，服务端算不出与预览一致的分页。
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Block, Character, Scene, ScriptConfig } from "@/lib/script-types";
import PrintPreview from "@/components/print/ScriptPrint";

export default function ScriptPrintRoute({
  productionId,
  blocks,
  characters,
  scenes,
  config,
  watermarkText,
}: {
  productionId: string;
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  config: ScriptConfig;
  watermarkText: string | null;
}) {
  const router = useRouter();
  // 排版模式在打印页只作用于本次预览，不回写演出配置——改配置是编辑器的事。
  const [textLayoutMode, setTextLayoutMode] = useState(config.textLayoutMode);

  return (
    <PrintPreview
      standalone
      blocks={blocks}
      characters={characters}
      scenes={scenes}
      pageLayout={config.pageLayout}
      stageDelimOpen={config.stageDelimOpen}
      stageDelimClose={config.stageDelimClose}
      textLayoutMode={textLayoutMode}
      watermarkText={watermarkText}
      canEditTextLayout={false}
      onTextLayoutModeChange={setTextLayoutMode}
      onClose={() => router.push(`/production/${productionId}/script`)}
    />
  );
}
