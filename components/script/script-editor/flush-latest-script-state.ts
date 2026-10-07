import type { ScriptState } from "@/lib/script/script-types";

/** 模式切换前持续冲刷，直到保存飞行期间产生的最后一次本地改动也已同步。 */
export async function flushLatestScriptState(
  readCurrent: () => ScriptState,
  push: (state: ScriptState) => Promise<boolean>,
  isSynced: (state: ScriptState) => boolean,
): Promise<boolean> {
  for (;;) {
    if (!await push(readCurrent())) return false;
    const latest = readCurrent();
    if (isSynced(latest)) return true;
  }
}
