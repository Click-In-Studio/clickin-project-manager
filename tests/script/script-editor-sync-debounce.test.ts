import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const editor = readFileSync("components/script/ScriptEditor.tsx", "utf8");
const sync = readFileSync("components/script/script-editor/script-sync.ts", "utf8");
const hook = readFileSync("components/script/script-editor/use-script-sync.ts", "utf8");

describe("ScriptEditor 自动同步的真实接线（#520、#507）", () => {
  it("编辑器使用共同保存维护者，传输仍通过原 PATCH 和条件依据", () => {
    expect(editor).toContain("useScriptSync(script, {");
    expect(editor).toContain("{ ...batch.patch, basis: batch.basis }");
    expect(hook).toContain("new ScriptSync(document, options)");
    expect(hook).toContain("sync.start()");
    expect(editor).not.toMatch(/syncedStateRef|pushPatchRef|syncTimerRef/);
  });
  it("维护者订阅文档，使用有上限的 debounce，而不是组件 effect 镜像", () => {
    expect(sync).toContain("this.document.subscribe(");
    expect(sync).toContain("{ wait: 1500, maxWait: 5000 }");
    expect(sync).toContain("this.deferred = true");
    expect(sync).toContain("this.stopped = true");
    expect(editor).not.toContain("createSaveDebounce");
  });
});
