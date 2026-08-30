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
  const [templateId, setTemplateId] = useState<string | null>(config.templateId);

  // 排版模版是**演出配置**不是本次预览的临时态：打印页里选了要落库（主本的
  // template_overrides.templateId）。预览阶段的「先看新页数再保存」在 PrintPreview 里做，
  // 这里只负责真正的保存：乐观 + 失败回滚，与编辑器 saveScriptConfig 同一套。
  const saveTemplateId = useCallback((next: string | null) => {
    const previous = templateId;
    setTemplateId(next);
    return fetch(`${BASE_PATH}/api/script/${productionId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, templateId: next }),
    })
      .then((r) => { if (!r.ok) { setTemplateId(previous); return false; } return true; })
      .catch(() => { setTemplateId(previous); return false; });
  }, [config, productionId, templateId]);

  return (
    <PrintPreview
      standalone
      blocks={blocks}
      characters={characters}
      scenes={scenes}
      pageLayout={config.pageLayout}
      stageDelimOpen={config.stageDelimOpen}
      stageDelimClose={config.stageDelimClose}
      textLayoutMode={config.textLayoutMode}
      templateId={templateId}
      watermarkText={watermarkText}
      canEditTemplate={canEditTextLayout}
      onTemplateSave={saveTemplateId}
      onClose={() => router.push(`/production/${productionId}/script`)}
    />
  );
}
