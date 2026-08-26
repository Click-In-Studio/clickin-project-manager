"use client";

/**
 * 打印路由的客户端外壳：数据由服务端取好传进来，这里只负责挂 PrintPreview
 * 并把「关闭」接回剧本页。
 *
 * 分页仍然是浏览器实测（逐块 offsetHeight），所以打印页必须是客户端组件——
 * 这不是可以省掉的一步，服务端算不出与预览一致的分页。
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import type { Block, Character, Scene, ScriptConfig } from "@/lib/script-types";
import PrintPreview from "@/components/print/ScriptPrint";

export default function ScriptPrintRoute({
  productionId,
  blocks,
  characters,
  scenes,
  config,
  watermarkText,
  canEditTextLayout,
}: {
  productionId: string;
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  config: ScriptConfig;
  watermarkText: string | null;
  canEditTextLayout: boolean;
}) {
  const router = useRouter();
  const [textLayoutMode, setTextLayoutMode] = useState(config.textLayoutMode);

  // 紧凑排版是**演出配置**不是本次预览的临时态：编辑器里改它会落库，
  // 打印页改它也必须落库，否则同一个开关在两处语义不同。
  // 乐观切换 + 失败回滚，与编辑器 saveScriptConfig 同一套。
  const changeTextLayoutMode = useCallback((mode: typeof textLayoutMode) => {
    const previous = textLayoutMode;
    setTextLayoutMode(mode);
    fetch(`${BASE_PATH}/api/script/${productionId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, textLayoutMode: mode }),
    })
      .then((r) => { if (!r.ok) setTextLayoutMode(previous); })
      .catch(() => setTextLayoutMode(previous));
  }, [config, productionId, textLayoutMode]);

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
      canEditTextLayout={canEditTextLayout}
      onTextLayoutModeChange={changeTextLayoutMode}
      onClose={() => router.push(`/production/${productionId}/script`)}
    />
  );
}
