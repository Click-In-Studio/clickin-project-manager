import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JsonTestResults } from "vitest/reporters";
import { describe, expect, it } from "vitest";
import { createReactWarningCollector } from "../_support/react-warning";

// 真实子运行器验证 setup 接线：警告必须让原本没有失败断言的 React 用例退出非零。
// 样例在临时目录生成，不会被日常全量发现成刻意失败的业务测试。
describe("React 错误警告护栏", () => {
  it("真实 React key、受控切换与渲染期更新警告都让测试失败，业务日志仍可通过", () => {
    const root = process.cwd();
    const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "clickin-react-warning-")));
    const fixture = path.join(scratch, "warnings.test.tsx");
    const config = path.join(scratch, "vitest.config.mjs");
    const reportPath = path.join(scratch, "results.json");
    const vitestPackagePath = fileURLToPath(import.meta.resolve("vitest/package.json"));
    const vitestPackage = JSON.parse(readFileSync(vitestPackagePath, "utf8")) as { bin: { vitest: string } };
    const runner = path.resolve(path.dirname(vitestPackagePath), vitestPackage.bin.vitest);
    try {
      writeFileSync(fixture, `
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { it, beforeEach, afterEach } from "vitest";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("missing-key", () => { act(() => root.render(<div>{[<span>a</span>, <span>b</span>]}</div>)); });
it("uncontrolled-controlled", () => {
  act(() => root.render(<input onChange={() => {}} />));
  act(() => root.render(<input value="x" onChange={() => {}} />));
});
it("controlled-uncontrolled", () => {
  act(() => root.render(<input value="x" onChange={() => {}} />));
  act(() => root.render(<input onChange={() => {}} />));
});
it("render-update", () => {
  function Child({ update }) { update(); return null; }
  function Parent() {
    const [updated, setUpdated] = useState(false);
    return updated ? null : <Child update={() => setUpdated(true)} />;
  }
  act(() => root.render(<Parent />));
});
it("business-error", () => { console.error("保存失败：网络不可用"); });
`);
      writeFileSync(config, `export default ${JSON.stringify({
        root: scratch,
        resolve: { alias: {
          "react-dom/client": fileURLToPath(import.meta.resolve("react-dom/client")),
          react: path.dirname(fileURLToPath(import.meta.resolve("react/package.json"))),
          vitest: fileURLToPath(import.meta.resolve("vitest")),
        } },
        test: {
          include: [fixture], environment: "jsdom", fileParallelism: false,
          setupFiles: [path.join(root, "tests/_support/setup.ts")],
        },
      })};`);
      const result = spawnSync(process.execPath, [runner, "run", "--config", config, "--reporter=json", "--outputFile", reportPath], {
        cwd: root, encoding: "utf8", timeout: 30_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as JsonTestResults;
      expect(report.numFailedTests, output).toBe(4);
      expect(report.numPassedTests, output).toBe(1);
      const assertions = report.testResults.flatMap(test => test.assertionResults);
      for (const name of ["missing-key", "uncontrolled-controlled", "controlled-uncontrolled", "render-update"]) {
        const assertion = assertions.find(test => test.title === name);
        expect(assertion?.status, output).toBe("failed");
        expect(assertion?.failureMessages?.join("\n"), name).toContain("React 错误警告");
      }
      expect(assertions.find(test => test.title === "business-error")?.status).toBe("passed");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  it("辨认带格式占位的重复 key 警告，允许普通业务失败日志", () => {
    const collector = createReactWarningCollector();
    collector.record(["保存失败", new Error("网络不可用")]);
    expect(() => collector.check()).not.toThrow();
    collector.record(["Encountered two children with the same key, `%s`.", "n1"]);
    expect(() => collector.check()).toThrow("n1");
  });

  it("同一配置将 tsx、jsdom ts 与 node SSR 纳入 ui，并从 db 排除", async () => {
    const { default: config } = await import("../../vitest.config");
    const projects = config.test!.projects! as { test: { name: string; include?: string[]; exclude?: string[]; globalSetup?: string } }[];
    const ui = projects.find(project => project.test.name === "ui")!.test;
    const db = projects.find(project => project.test.name === "db")!.test;
    expect(ui.globalSetup).toBeUndefined();
    expect(db.globalSetup).toBe("./tests/_support/global-setup.ts");
    for (const file of ["tests/wiki/wiki-print-watermark.test.tsx", "tests/wiki/mention-chip-reload.test.ts", "tests/account/login-ssr.test.ts"]) {
      expect(ui.include).toContain(file);
      expect(db.exclude).toContain(file);
    }
    expect(ui.include).not.toContain("tests/wiki/wiki-library.test.ts");
    expect(config.test!.setupFiles).toContain("./tests/_support/setup.ts");
    expect(readFileSync("tests/_support/setup.ts", "utf8")).toContain("collector.check()");
  });
});
