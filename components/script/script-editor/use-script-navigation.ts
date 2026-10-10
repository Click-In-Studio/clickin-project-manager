"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ScriptNavigation } from "./script-navigation";
import type { ScriptDocument } from "./script-document";

export function useScriptNavigation(document: ScriptDocument) {
  const [navigation] = useState(() => new ScriptNavigation());
  const waiting = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  useEffect(() => document.subscribe(() => navigation.reconcile(document.getSnapshot().blockIndexById)), [document, navigation]);
  return { navigation, explicitLoadTargetIndex: waiting?.index ?? null };
}
