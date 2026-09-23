/**
 * 评论面板懒加载要带加载态（#647）。
 *
 * #641 把评论面板改成按需加载，剧本首屏包小了四成；代价是点开评论要先等
 * chunk 过网络，而那一段原先没有任何反馈——面板不出现，按钮也没有变化，
 * 慢网下就是「点了没反应」。
 *
 * 错法同样是静默的：把 CommentsPanelLazy 的动态 import 改回静态 import，
 * 或者把 Suspense fallback 去掉，功能都照常，只是首屏包重新变胖 / 等待重新
 * 没提示。所以三头都要盯：ScriptEditor 只认那层壳、壳只动态引真面板、
 * fallback 画的是同一个面板外壳而不是空白。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const editor = read("components/script/ScriptEditor.tsx");
const shell = read("components/script/script-editor/CommentsPanelLazy.tsx");

describe("评论面板懒加载与加载态（#647）", () => {
  it("ScriptEditor 只认懒加载壳，不静态 import 真面板", () => {
    expect(editor).toMatch(/from "\.\/script-editor\/CommentsPanelLazy"/);
    expect(editor).not.toMatch(/import CommentsPanel from "\.\/script-editor\/CommentsPanel"/);
  });

  it("壳对真面板只有动态 import 和类型 import", () => {
    expect(shell).toMatch(/lazy\(importCommentsPanel\)/);
    expect(shell).toMatch(/import\("\.\/CommentsPanel"\)/);
    expect(shell).toMatch(/import type \{ CommentsPanelProps \} from "\.\/CommentsPanel"/);
  });

  // 白名单而不是黑名单：新增一条静态 import 就红，逼人当场说清它拖不拖编辑器
  // 那条线——`tsc` 与 vitest 都不报这类回退，只有构建产物看得出来。
  it("壳的静态 import 只有 react 与面板外壳（纯类型那条不算）", () => {
    const statics = [...shell.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";$/gm)]
      .filter(m => !m[1])
      .map(m => m[2]);
    expect(statics.sort()).toEqual(["./SideBlockPanel", "react"]);
  });

  it("等待期间画的是面板外壳 + 加载提示，不是空白", () => {
    expect(shell).toMatch(/fallback=\{[\s\S]*?<SideBlockPanel[\s\S]*?加载中[\s\S]*?<\/SideBlockPanel>/);
  });

  it("首屏画完后空闲预热 chunk，让壳只是兜底", () => {
    expect(editor).toMatch(/preloadCommentsPanel\(\)/);
    expect(editor).toMatch(/requestIdleCallback/);
  });
});
