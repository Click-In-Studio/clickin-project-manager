/**
 * 标签与整本并发加载（#650）。
 *
 * 错法是静默的——功能照常，只是标签请求排在整本回包之后，成了瀑布的第四段：
 * 块先出来、标签晚一拍浮现。tag_group 一落地每个非 stage 块都多出一行胶囊
 * （ScriptBlock 的 hasBlockTags 只看 tagGroups.length），所以「晚到」= 全窗口重排。
 *
 * 钉三件事：两条标签请求在 await 整本之前就发出；ready 排在标签落地之后；
 * 标签落地前过 cancelled 门（切版本时旧标签不能覆盖新版本）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const editor = readFileSync(path.join(process.cwd(), "components/script/ScriptEditor.tsx"), "utf8");

describe("剧本标签与整本并发加载（#650）", () => {
  it("标签请求在 await 整本之前发出", () => {
    const tagsStart = editor.search(/Promise\.allSettled\(\[fetchTagGroups\(productionId\), fetchBlockTags\(effectiveScriptId\)\]\)/);
    const envelopeAwait = editor.search(/const r = await loadScriptEnvelope\(productionId, effectiveScriptId, activeVersionId\)/);
    expect(tagsStart).toBeGreaterThan(-1);
    expect(envelopeAwait).toBeGreaterThan(-1);
    expect(tagsStart).toBeLessThan(envelopeAwait);
  });

  it("ready 排在标签落地之后，且落地前过 cancelled 门", () => {
    const landing = editor.match(/const \[tgRes, btRes\] = await tagsPromise;\s*if \(cancelled\) return;/);
    expect(landing).not.toBeNull();
    const landingAt = editor.indexOf(landing![0]);
    const readyAt = editor.indexOf('setLoadState("ready")');
    expect(readyAt).toBeGreaterThan(landingAt);
    // 旧写法：ready 之后才 Promise.all 两条标签
    expect(editor).not.toMatch(/setLoadState\("ready"\);[\s\S]{0,200}?Promise\.all\(\[\s*fetchTagGroups/);
  });
});
