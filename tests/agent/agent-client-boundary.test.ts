import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// 用真实客户端入口构建，避免 Node 环境下的解析单测掩盖依赖越界。
describe("AI 助手客户端依赖边界", () => {
  it("AgentPopout 可打包到浏览器且身份解析不引入服务端生成模块", async () => {
    const result = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ["components/agent/AgentPopout.tsx"],
      bundle: true,
      platform: "browser",
      packages: "external",
      write: false,
      metafile: true,
      loader: { ".css": "empty" },
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile!.inputs).map((input) => path.normalize(input));
    expect(inputs).toContain(path.normalize("lib/agent/tools/session-identity-parse.ts"));
    expect(inputs).not.toContain(path.normalize("lib/agent/tools/session-identity.ts"));
  });
});
