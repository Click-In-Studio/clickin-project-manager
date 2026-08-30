/**
 * 模版引擎的第一块试金石（docs/script-template-engine.md §4）：legacy 模版下，
 * 估算器的输出必须与接入引擎之前的实现**逐字节相同**。
 *
 * 参照物是旧实现的原文（tests/fixtures/legacy-script-page.ts）。随机剧本覆盖：
 * 场次切换、排练记号切换、同角色连续、多角色、角色标注、括号提示、强制显示角色名、
 * 歌词、舞台指示、空块、中英混排、超长块——四种版式 × 两种排版模式全部比对。
 *
 * 另外钉两条引擎内部的一致性：
 *   · 通用分页器 paginate(plan, estimate) 与 computePageMap 的手写循环结果相同
 *     （打印管线 T2 起改吃 paginate，估算器与打印从此走同一条算法）
 *   · updateEstimatedPageMap 的增量路径与全量 computePageMap 相同
 */
import { describe, it, expect } from "vitest";
import { faker } from "@faker-js/faker";
import type { Block, PageLayout, ScriptTextLayoutMode } from "@/lib/script-types";
import { computePageMap, updateEstimatedPageMap, PAGE_CONFIGS } from "@/lib/script-page";
import {
  computePageMap as legacyComputePageMap,
  updateEstimatedPageMap as legacyUpdateEstimatedPageMap,
} from "./fixtures/legacy-script-page";
import { estimateItemHeight, paginate, planScript, templateForTextLayoutMode } from "@/lib/script-template";
import { withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";

const LAYOUTS: PageLayout[] = ["a4", "letter", "a3-2col", "tablet-2col"];
const MODES: ScriptTextLayoutMode[] = ["center", "compact"];

const CJK = "这一句台词是为了把页撑满而写的证人文本，夜色里没有人回头路灯把影子拉成一句没说完的话";
function cjkText(min: number, max: number): string {
  const n = faker.number.int({ min, max });
  let s = "";
  while (s.length < n) s += CJK.slice(faker.number.int({ min: 0, max: 20 }));
  return s.slice(0, n);
}
function mixedText(): string {
  const parts = [cjkText(5, 60), faker.lorem.words(faker.number.int({ min: 1, max: 12 })), cjkText(0, 80), "（走近）", "**强调**", "3 号线 10 号线 19:05"];
  return faker.helpers.shuffle(parts).slice(0, faker.number.int({ min: 1, max: 4 })).join(faker.helpers.arrayElement(["", " ", "\n"]));
}

/** 随机剧本：章节 / 场次 / 排练记号 marker + 正文块，形状尽量刁钻 */
function randomScript(): Block[] {
  const blocks: Block[] = [];
  const chars = ["c1", "c2", "c3"];
  const chapters = faker.number.int({ min: 1, max: 2 });
  for (let c = 0; c < chapters; c++) {
    blocks.push({ id: `ch${c}`, type: "chapter_marker", content: "", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null, markerMeta: { name: `第${c + 1}幕` } });
    const scenes = faker.number.int({ min: 1, max: 3 });
    for (let sc = 0; sc < scenes; sc++) {
      if (sc > 0) blocks.push({ id: `sc${c}-${sc}`, type: "scene_marker", content: "", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null, markerMeta: { name: `第${sc + 1}场` } });
      const n = faker.number.int({ min: 3, max: 40 });
      let lastChars: string[] = [];
      for (let i = 0; i < n; i++) {
        if (faker.datatype.boolean({ probability: 0.12 })) {
          blocks.push({ id: `rm${c}-${sc}-${i}`, type: "rehearsal_marker", content: "", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null, markerMeta: {} });
        }
        const isStage = faker.datatype.boolean({ probability: 0.15 });
        const repeat = faker.datatype.boolean({ probability: 0.45 });
        const characterIds = isStage ? [] : repeat && lastChars.length ? [...lastChars] : faker.helpers.arrayElements(chars, faker.number.int({ min: 0, max: 2 }));
        if (!isStage) lastChars = characterIds;
        const annotations: Record<string, string> = {};
        for (const id of characterIds) if (faker.datatype.boolean({ probability: 0.3 })) annotations[id] = faker.helpers.arrayElement(["旁白", "画外音", "OS"]);
        blocks.push({
          id: `b${c}-${sc}-${i}`,
          type: isStage ? "stage" : "dialogue",
          content: faker.datatype.boolean({ probability: 0.08 }) ? "" : mixedText(),
          stageComment: !isStage && faker.datatype.boolean({ probability: 0.25 }) ? faker.helpers.arrayElement(["笑", "沉默片刻\n转向窗外", "看表"]) : null,
          forceShowCharacterName: faker.datatype.boolean({ probability: 0.1 }),
          characterIds,
          characterAnnotations: annotations,
          lyric: !isStage && faker.datatype.boolean({ probability: 0.2 }),
          sceneId: null,
          rehearsalMark: null,
        });
      }
    }
  }
  return blocks;
}

const SCRIPTS = Array.from({ length: 24 }, randomScript);

describe("legacy 模版：估算器输出与旧实现逐字节相同", () => {
  for (const layout of LAYOUTS) {
    for (const mode of MODES) {
      it(`${layout} / ${mode}：computePageMap 全量`, () => {
        for (const blocks of SCRIPTS) {
          expect(computePageMap(blocks, layout, mode)).toEqual(legacyComputePageMap(blocks, layout, mode));
        }
      });
      it(`${layout} / ${mode}：updateEstimatedPageMap 全量与增量`, () => {
        for (const blocks of SCRIPTS) {
          const mine = updateEstimatedPageMap(null, blocks, layout, mode);
          const theirs = legacyUpdateEstimatedPageMap(null, blocks, layout, mode);
          expect(mine.pageMap).toEqual(theirs.pageMap);
          // 改一块内容后增量重算
          const edited = blocks.map((b, i) => (i === Math.floor(blocks.length / 2) ? { ...b, content: b.content + cjkText(30, 120) } : b));
          const dirty = [{ start: Math.floor(blocks.length / 2), end: Math.floor(blocks.length / 2) + 1 }];
          expect(updateEstimatedPageMap(mine, edited, layout, mode, false, dirty).pageMap)
            .toEqual(legacyUpdateEstimatedPageMap(theirs, edited, layout, mode, false, dirty).pageMap);
        }
      });
    }
  }
});

describe("引擎内部一致性", () => {
  it("通用分页器 paginate(plan, estimate) 与 computePageMap 的手写循环相同", () => {
    for (const layout of LAYOUTS) {
      for (const mode of MODES) {
        const template = templateForTextLayoutMode(mode);
        const cfg = PAGE_CONFIGS[layout];
        const contentWidth = cfg.width - cfg.marginX * 2;
        const contentHeight = cfg.height - cfg.marginTop - cfg.marginBottom;
        for (const blocks of SCRIPTS) {
          const projected = withLegacyOwnershipProjection(withMarkerOwnership(blocks));
          // 估算器的口径：无角色表（有角色就占位一行）、无场次表、括号 （）
          const characters = [...new Set(projected.flatMap((b) => b.characterIds))].map((id) => ({ id, name: "角", isAggregate: false }));
          const items = planScript(projected, { template, characters, scenes: [], stageDelimOpen: "（", stageDelimClose: "）" });
          const result = paginate(items, {
            contentHeight,
            countGapBefore: template.estimate.countGapBefore,
            heightOf: (item, variant) => estimateItemHeight(item, variant, contentWidth, template.estimate),
          });
          expect(result.pageMap).toEqual(computePageMap(blocks, layout, mode));
        }
      }
    }
  });

  it("随机剧本确实跨了多页（否则上面的比对没有说服力）", () => {
    const pages = SCRIPTS.map((blocks) => Math.max(0, ...Object.values(computePageMap(blocks, "a4", "center"))));
    expect(Math.max(...pages)).toBeGreaterThan(3);
  });
});
