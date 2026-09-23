/**
 * 首屏只拉一次整本（#641）。
 *
 * 错法是静默的——页面照常打开，只是「加载中」走两遍、整本剧本过两趟线：
 * ScriptEditor 的加载 effect 依赖 activeVersionId，而它自己在回包后 setActiveVersionId。
 * 初值是裸 null 时，第一个请求不带 ?v=，回包的 versionId 一落地就把依赖改了，
 * effect 重跑、setLoadState("loading")、整本再拉一遍（tag-groups / block-tags /
 * 场次详情 / SSE 建连一并重来）。
 *
 * 所以两头都要盯：服务端把活跃版本随页面下发，客户端拿它当首帧初值。
 * 另附 TTFB 那道：页面里的门是一轮并发，不是逐个 await 串起来的 DB 往返。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const page = readFileSync(path.join(process.cwd(), "app/production/[id]/script/page.tsx"), "utf8");
const editor = readFileSync(path.join(process.cwd(), "components/script/ScriptEditor.tsx"), "utf8");

describe("剧本首屏只拉一次整本（#641）", () => {
  it("页面把服务端解析的活跃版本下发给编辑器", () => {
    expect(page).toMatch(/getActiveVersionId\(id\)/);
    expect(page).toMatch(/initialVersionId=\{activeVersionId\}/);
  });

  it("编辑器的 activeVersionId 首帧取自 prop，不是裸 null", () => {
    expect(editor).toMatch(/useState<string \| null>\(initialVersionId\)/);
    expect(editor).not.toMatch(/const \[activeVersionId, setActiveVersionId\] = useState<string \| null>\(null\)/);
  });

  it("回包版本与当前同值时不再 setState（否则白渲染一帧）", () => {
    expect(editor).toMatch(/resolvedVid !== activeVersionId\) setActiveVersionId\(resolvedVid\)/);
  });

  it("页面的门一轮并发拿完：直接 await 的 hasEffectiveGrant 至多剩 canEditLayout 那一处", () => {
    expect(page.match(/await hasEffectiveGrant\(/g) ?? []).toHaveLength(1);
    expect(page).toMatch(/await Promise\.all\(\[[\s\S]*?hasEffectiveGrant\([\s\S]*?\]\)/);
  });
});
