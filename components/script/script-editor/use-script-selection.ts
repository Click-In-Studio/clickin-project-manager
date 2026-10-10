"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ScriptDocument } from "./script-document";
import { ScriptSelection } from "./script-selection-state";

export function useScriptSelection(document: ScriptDocument) {
  const [selection] = useState(() => new ScriptSelection(() => document.getSnapshot().blocks));
  const snapshot = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
  useEffect(() => document.subscribe(selection.reconcile), [document, selection]);
  return { selection, snapshot };
}
