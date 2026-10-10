"use client";

import { useState, useSyncExternalStore } from "react";
import type { ScriptWindowBootstrap } from "@/lib/script/script-window-types";
import { ScriptDocument } from "./script-document";

export function useScriptDocument(bootstrap?: ScriptWindowBootstrap | null) {
  const [document] = useState(() => new ScriptDocument(bootstrap));
  const snapshot = useSyncExternalStore(document.subscribe, document.getSnapshot, document.getSnapshot);
  return { document, snapshot };
}
