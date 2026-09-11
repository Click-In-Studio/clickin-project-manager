import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspacePrompt, resetWorkspacePromptForTests, WORKSPACE_FILES, buildSystemPrompt } from "@/lib/agent-runtime/prompt";
import { exposedName } from "@/lib/agent-runtime/tools";

// AI review #372：workspacePrompt 缺文件时要喊一声——但每个文件只喊一次（长驻进程不刷屏），
// 文件齐全时不喊，mtime 缓存不受影响。PR #371 首发就是 standalone 没带 openclaw-workspace/
// 而代码静默降级，线上 base prompt 变空没人发现。

describe("workspacePrompt", () => {
  let tmp: string;
  const prevDir = process.env.AGENT_WORKSPACE_DIR;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clickin-ws-"));
    process.env.AGENT_WORKSPACE_DIR = tmp;
    resetWorkspacePromptForTests();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    if (prevDir === undefined) delete process.env.AGENT_WORKSPACE_DIR; else process.env.AGENT_WORKSPACE_DIR = prevDir;
    resetWorkspacePromptForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("目录空：每个缺席文件警告一次，重复调用不再刷；返回空 prompt 而不是抛错", () => {
    expect(workspacePrompt()).toBe("");
    expect(errorSpy).toHaveBeenCalledTimes(WORKSPACE_FILES.length);
    workspacePrompt();
    workspacePrompt();
    expect(errorSpy).toHaveBeenCalledTimes(WORKSPACE_FILES.length);
    for (const name of WORKSPACE_FILES) expect(errorSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(name))).toBe(true);
  });

  it("文件齐全：按顺序拼接、不警告；内容不变时命中缓存，改文件后（mtime 变）重读", async () => {
    for (const name of WORKSPACE_FILES) fs.writeFileSync(path.join(tmp, name), `# ${name}\n内容-${name}\n`);
    const first = workspacePrompt();
    expect(first.startsWith("# AGENTS.md")).toBe(true);
    expect(first.split("\n\n").length).toBe(WORKSPACE_FILES.length);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(workspacePrompt()).toBe(first); // 缓存

    await new Promise((r) => setTimeout(r, 15)); // 保证 mtime 变化
    fs.writeFileSync(path.join(tmp, "TOOLS.md"), "# TOOLS.md\n新内容\n");
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(tmp, "TOOLS.md"), t + 5, t + 5);
    expect(workspacePrompt()).toContain("新内容");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("仓库自带的 openclaw-workspace 五件齐全（部署带上的就是这五个）", () => {
    process.env.AGENT_WORKSPACE_DIR = path.join(process.cwd(), "openclaw-workspace");
    resetWorkspacePromptForTests();
    const text = workspacePrompt();
    expect(text.length).toBeGreaterThan(500);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// 网关退役（#377）后 TOOLS.md 只有本运行时一个读者，能力描述必须与注册表同源：
// 曾经是 TOOLS.md 写「没有主动提问的工具」、prompt 里再追一段更正，每轮送两句
// 自相矛盾的话。这里守住「文件即事实」，不再靠补充块打补丁。
describe("base prompt 与工具注册表同源", () => {
  const prevDir = process.env.AGENT_WORKSPACE_DIR;
  beforeEach(() => {
    process.env.AGENT_WORKSPACE_DIR = path.join(process.cwd(), "openclaw-workspace");
    resetWorkspacePromptForTests();
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.AGENT_WORKSPACE_DIR; else process.env.AGENT_WORKSPACE_DIR = prevDir;
    resetWorkspacePromptForTests();
  });

  it("TOOLS.md 描述的能力与常驻工具一致，且没有反向陈述", () => {
    const text = buildSystemPrompt({ instructions: null, knowledge: null, memory: null });
    for (const name of ["ask_user", "web.search", "web.fetch"]) {
      expect(text).toContain(exposedName(name));
    }
    expect(text).not.toContain("没有向用户主动提问的工具");
  });
});
