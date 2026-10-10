"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ScriptDocument } from "./script-document";
import { ScriptSync, type ScriptSyncOptions } from "./script-sync";

export function useScriptSync(document: ScriptDocument, options: ScriptSyncOptions) {
  const [sync] = useState(() => new ScriptSync(document, options));
  sync.configure(options);
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
  useEffect(() => sync.start(), [sync]);
  return { sync, snapshot };
}
