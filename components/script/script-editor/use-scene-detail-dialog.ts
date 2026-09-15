"use client";

import { useState } from "react";

/** 场次详情对话框：打开的场次 id + 是否处于编辑态。从 ScriptEditor 主函数体原样搬出（#487 S5）。 */
export function useSceneDetailDialog() {
  const [sceneDetailDialogSceneId, setSceneDetailDialogSceneId] = useState<string | null>(null);
  const [sceneDetailDialogEditing, setSceneDetailDialogEditing] = useState(false);
  const openSceneDetailDialog = (sceneId: string) => {
    setSceneDetailDialogEditing(false);
    setSceneDetailDialogSceneId(sceneId);
  };
  const closeSceneDetailDialog = () => {
    setSceneDetailDialogEditing(false);
    setSceneDetailDialogSceneId(null);
  };

  return { sceneDetailDialogSceneId, sceneDetailDialogEditing, setSceneDetailDialogEditing, openSceneDetailDialog, closeSceneDetailDialog };
}
