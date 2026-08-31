import { describe, it, expect } from "vitest";
import {
  applyDialectToBlocks,
  serializeBlocksToDialect,
  SCRIPT_DIALECT_NOTE,
} from "@/lib/script-dialect";
import { diffState } from "@/lib/script-ops";
import { withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";
import type { Block, Character, ScriptState } from "@/lib/script-types";

/**
 * 剧本方言 P0 护栏：序列化 → 解析回填的往返必须产出空 patch（id 往返协议的
 * 根基——任何虚假 diff 都会变成对 cue/tag/page_map 锚点的无谓 CoW），
 * 各类编辑必须映射为最小 op 组合，畸形输入必须给出可教学的错误。
 */

const chars: Character[] = [
  { id: "c-zhang", name: "张三", isAggregate: false },
  { id: "c-li", name: "李四", isAggregate: false },
];

function mkText(id: string, content: string, extra: Partial<Block> = {}): Block {
  return {
    id,
    type: "dialogue",
    content,
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
    ...extra,
  };
}

function mkMarker(id: string, type: Block["type"], content: string, parentMarkerId: string | null): Block {
  return {
    id,
    type,
    content,
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
    markerMeta: { parentMarkerId },
  };
}

/** 与 applyDialectToBlocks 输出同一套 canonical 投影，保证 diff 只反映真实编辑 */
function canon(blocks: Block[]): Block[] {
  return withLegacyOwnershipProjection(withMarkerOwnership(blocks));
}

function baseBlocks(): Block[] {
  return canon([
    mkMarker("m-ch", "chapter_marker", "第一幕", null),
    mkMarker("m-sc", "scene_marker", "开端", "m-ch"),
    mkText("d1", "你来了。", { characterIds: ["c-zhang"] }),
    mkText("d2", "第一行\n第二行", {
      characterIds: ["c-zhang", "c-li"],
      characterAnnotations: { "c-li": "低声" },
      stageComment: "两人对视",
    }),
    mkText("s1", "灯光渐暗。", { type: "stage" }),
    mkText("d3", "画外音内容"),
    mkText("d4", "月亮之上", { characterIds: ["c-li"], lyric: true, forceShowCharacterName: true }),
  ]);
}

function st(blocks: Block[]): ScriptState {
  return { blocks, characters: chars, scenes: [], config: DEFAULT_SCRIPT_CONFIG };
}

function roundTrip(all: Block[], mutate?: (lines: string[]) => string[]) {
  let lines = serializeBlocksToDialect(all, chars).split("\n");
  if (mutate) lines = mutate(lines);
  return applyDialectToBlocks({
    allBlocks: all,
    rangeBlockIds: all.map((b) => b.id),
    dialect: lines.join("\n"),
    characters: chars,
    newId: (() => {
      let n = 0;
      return () => `nb${++n}`;
    })(),
  });
}

function headIndex(lines: string[], id: string): number {
  const idx = lines.findIndex((l) => l.startsWith(`[b:${id}]`));
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

describe("往返一致性", () => {
  it("serialize → parse → diffState 为空 patch", () => {
    const all = baseBlocks();
    const res = roundTrip(all);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const patch = diffState(st(all), st(res.blocks), 1);
    expect(patch.blockOps).toEqual([]);
    expect(patch.charOps).toEqual([]);
    expect(patch.sceneOps).toEqual([]);
    expect(res.summary).toEqual({ inserted: [], updated: [], deleted: [], retained: 5 });
  });

  it("未动的块保持原对象引用（含悬空角色 id 的块）", () => {
    const all = canon([
      mkMarker("m-ch", "chapter_marker", "一", null),
      mkText("d1", "台词", { characterIds: ["c-zhang", "c-ghost"] }), // c-ghost 已不存在
    ]);
    const res = roundTrip(all);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.blocks[1]).toBe(all[1]); // 悬空 id 序列化被跳过，但块判定为未变
  });

  it("CRLF 正文归一化不产生虚假更新", () => {
    const all = canon([
      mkMarker("m-ch", "chapter_marker", "一", null),
      mkText("d1", "a\r\nb", { characterIds: ["c-zhang"] }),
    ]);
    const res = roundTrip(all);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.blocks[1]).toBe(all[1]);
  });

  it("正文行首与标记撞形时转义往返", () => {
    const all = canon([
      mkMarker("m-ch", "chapter_marker", "一", null),
      mkText("d1", "[白] 这是正文不是标记"),
    ]);
    const text = serializeBlocksToDialect(all, chars);
    expect(text).toContain("\\[白]");
    const res = roundTrip(all);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const patch = diffState(st(all), st(res.blocks), 1);
    expect(patch.blockOps).toEqual([]);
  });

  it("标记锚点后的标题只读——改了也不产生任何 op", () => {
    const all = baseBlocks();
    const res = roundTrip(all, (lines) =>
      lines.map((l) => (l.startsWith("[m:m-sc]") ? "[m:m-sc] ## 被改过的标题" : l)),
    );
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const patch = diffState(st(all), st(res.blocks), 1);
    expect(patch.blockOps).toEqual([]);
  });
});

describe("最小 diff 映射", () => {
  it("改一个块的内容 → 恰好一个 update", () => {
    const all = baseBlocks();
    const res = roundTrip(all, (lines) => {
      const i = headIndex(lines, "d1");
      lines[i] = "[b:d1] 张三：你终于来了。";
      return lines;
    });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.summary.updated).toEqual(["d1"]);
    const patch = diffState(st(all), st(res.blocks), 1);
    expect(patch.blockOps).toHaveLength(1);
    expect(patch.blockOps[0]).toMatchObject({ op: "update", block: { id: "d1", content: "你终于来了。" } });
  });

  it("[new] 插入 → insert op 带正确 afterId，归属自动挂到所在场", () => {
    const all = baseBlocks();
    const res = roundTrip(all, (lines) => {
      const i = headIndex(lines, "d1");
      lines.splice(i + 1, 0, "[new] 李四（急促）：等等我！");
      return lines;
    });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.summary.inserted).toEqual(["nb1"]);
    const inserted = res.blocks.find((b) => b.id === "nb1")!;
    expect(inserted.characterIds).toEqual(["c-li"]);
    expect(inserted.characterAnnotations).toEqual({ "c-li": "急促" });
    expect(inserted.sceneId).toBe("m-sc");
    expect(inserted.ownerMarkerId).toBe("m-sc");
    const patch = diffState(st(all), st(res.blocks), 1);
    expect(patch.blockOps).toHaveLength(1);
    expect(patch.blockOps[0]).toMatchObject({ op: "insert", afterId: "d1", block: { id: "nb1" } });
  });

  it("省略既有块 → delete op", () => {
    const all = baseBlocks();
    const res = roundTrip(all, (lines) => {
      const i = headIndex(lines, "d3");
      lines.splice(i, 1);
      return lines;
    });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.summary.deleted).toEqual(["d3"]);
    const patch = diffState(st(all), st(res.blocks), 1);
    expect(patch.blockOps).toEqual([{ op: "delete", id: "d3" }]);
  });

  it("调换保留块顺序 → reorder op（无 update）", () => {
    const all = baseBlocks();
    const res = roundTrip(all, (lines) => {
      const i1 = headIndex(lines, "d1");
      const i3 = headIndex(lines, "d3");
      [lines[i1], lines[i3]] = [lines[i3], lines[i1]];
      return lines;
    });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const patch = diffState(st(all), st(res.blocks), 1);
    expect(patch.blockOps.map((o) => o.op)).toEqual(["reorder"]);
  });

  it("[白] 清空说话人、[提示] 增删、[歌]/[显名] 翻转都算 update", () => {
    const all = baseBlocks();
    const res = roundTrip(all, (lines) => {
      const i1 = headIndex(lines, "d1");
      lines[i1] = "[b:d1] [白] 你来了。"; // 清空说话人
      const i4 = headIndex(lines, "d4");
      lines[i4] = "[b:d4] 李四：月亮之上"; // 去掉 [歌] 与 [显名]
      const hint = lines.findIndex((l) => l.startsWith("[提示]"));
      lines.splice(hint, 1); // 删掉 d2 的舞台提示
      return lines;
    });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.summary.updated.slice().sort()).toEqual(["d1", "d2", "d4"]);
    const byId = new Map(res.blocks.map((b) => [b.id, b]));
    expect(byId.get("d1")!.characterIds).toEqual([]);
    expect(byId.get("d2")!.stageComment).toBeNull();
    expect(byId.get("d4")!.lyric).toBe(false);
    expect(byId.get("d4")!.forceShowCharacterName).toBe(false);
  });

  it("多行正文与空续行往返；续行编辑生效", () => {
    const all = canon([
      mkMarker("m-ch", "chapter_marker", "一", null),
      mkText("d1", "上\n\n下", { characterIds: ["c-zhang"] }),
    ]);
    const clean = roundTrip(all);
    if (!clean.ok) throw new Error(JSON.stringify(clean.errors));
    expect(diffState(st(all), st(clean.blocks), 1).blockOps).toEqual([]);

    const edited = roundTrip(all, (lines) => lines.map((l) => (l === "| 下" ? "| 改过的下" : l)));
    if (!edited.ok) throw new Error(JSON.stringify(edited.errors));
    expect(edited.blocks.find((b) => b.id === "d1")!.content).toBe("上\n\n改过的下");
  });
});

describe("区间作用域", () => {
  it("只改区间内，区间外的块保持原引用", () => {
    const all = baseBlocks();
    const range = all.slice(2); // d1 起（m-ch/m-sc 之外的纯正文段也允许）
    const dialect = "[b:d1] 张三：区间内改写。";
    // 其余正文块被省略 = 删除；d1 保留
    const res = applyDialectToBlocks({
      allBlocks: all,
      rangeBlockIds: range.map((b) => b.id),
      dialect,
      characters: chars,
    });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.summary.deleted.slice().sort()).toEqual(["d2", "d3", "d4", "s1"]);
    expect(res.blocks[0]).toBe(all[0]);
    expect(res.blocks[1]).toBe(all[1]);
    expect(res.blocks).toHaveLength(3);
  });

  it("非连续区间直接抛错（程序错误，不是模型错误）", () => {
    const all = baseBlocks();
    expect(() =>
      applyDialectToBlocks({
        allBlocks: all,
        rangeBlockIds: ["d1", "d3"],
        dialect: "",
        characters: chars,
      }),
    ).toThrow(/连续/);
  });
});

describe("解析错误（教学面）", () => {
  function expectError(all: Block[], mutate: (lines: string[]) => string[], fragment: string) {
    const res = roundTrip(all, mutate);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.message).join("\n")).toContain(fragment);
  }

  it("伪造/串段的 [b:id] 被拒", () => {
    expectError(baseBlocks(), (lines) => {
      lines.push("[b:outside] 张三：混进来的");
      return lines;
    }, "不在本次改写的区间内");
  });

  it("重复 [b:id] 被拒", () => {
    expectError(baseBlocks(), (lines) => {
      const i = headIndex(lines, "d1");
      lines.push(lines[i]);
      return lines;
    }, "重复出现");
  });

  it("删掉标记锚点被拒", () => {
    expectError(baseBlocks(), (lines) => lines.filter((l) => !l.startsWith("[m:m-sc]")), "标记锚点缺失");
  });

  it("调换标记锚点顺序被拒", () => {
    expectError(baseBlocks(), (lines) => {
      const a = lines.findIndex((l) => l.startsWith("[m:m-ch]"));
      const b = lines.findIndex((l) => l.startsWith("[m:m-sc]"));
      [lines[a], lines[b]] = [lines[b], lines[a]];
      return lines;
    }, "顺序与原文不一致");
  });

  it("用 [b:] 引用标记 id 被拒并指路 [m:]", () => {
    expectError(baseBlocks(), (lines) => {
      lines.push("[b:m-sc] 张三：想改标记");
      return lines;
    }, "标记块的 id");
  });

  it("未知说话人报错并给出创建指引", () => {
    expectError(baseBlocks(), (lines) => {
      lines.push("[new] 王五：我是谁");
      return lines;
    }, "王五");
  });

  it("字面写同名角色报错并指路 #<id>；序列化侧对同名角色自动走 #<id>，往返不受影响", () => {
    const dupChars: Character[] = [...chars, { id: "c-zhang2", name: "张三", isAggregate: false }];
    const all = baseBlocks();
    const text = serializeBlocksToDialect(all, dupChars);
    expect(text).toContain("#c-zhang"); // 同名 → 不走字面量
    const ok = applyDialectToBlocks({
      allBlocks: all, rangeBlockIds: all.map((b) => b.id), dialect: text, characters: dupChars,
    });
    if (!ok.ok) throw new Error(JSON.stringify(ok.errors));
    expect(diffState(st(all), { ...st(ok.blocks), characters: dupChars }, 1).blockOps).toEqual([]);

    const literal = applyDialectToBlocks({
      allBlocks: all, rangeBlockIds: all.map((b) => b.id),
      dialect: `${text}\n[new] 张三：谁在说话`, characters: dupChars,
    });
    expect(literal.ok).toBe(false);
    if (!literal.ok) expect(literal.errors.map((e) => e.message).join()).toContain("#<角色id>");
  });

  it("无说话人且无标记的行提示 [白]", () => {
    expectError(baseBlocks(), (lines) => {
      lines.push("[new] 就一句没有冒号的话");
      return lines;
    }, "[白]");
  });

  it("孤立的 [提示] / 续行、# 手写结构、完全无法识别的行各有专属错误", () => {
    const all = baseBlocks();
    const res = applyDialectToBlocks({
      allBlocks: all,
      rangeBlockIds: all.map((b) => b.id),
      dialect: "[提示] 无主提示\n# 第二幕\n随便一行",
      characters: chars,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const msgs = res.errors.map((e) => e.message).join("\n");
    expect(msgs).toContain("[提示] 行之前没有任何块");
    expect(msgs).toContain("scene_propose_*");
    expect(msgs).toContain("无法识别的行");
  });

  it("[台] 与其他标记组合被拒", () => {
    expectError(baseBlocks(), (lines) => {
      lines.push("[new] [台] [歌] 不合法");
      return lines;
    }, "[台]");
  });
});

describe("说话人段转义加固（变长方言的错切防线）", () => {
  const weirdChars: Character[] = [
    ...chars,
    { id: "c-weird", name: "旁：白、员[歌]", isAggregate: false }, // 名字含全部保留字符类
  ];

  function applyWith(all: Block[], dialect: string, characters: Character[]) {
    return applyDialectToBlocks({
      allBlocks: all, rangeBlockIds: all.map((b) => b.id), dialect, characters, newId: () => "nb1",
    });
  }

  it("不安全角色名序列化走 #<id>，往返空 diff；#<id> 也可用于新块", () => {
    const all = canon([
      mkMarker("m-ch", "chapter_marker", "一", null),
      mkText("d1", "台词", { characterIds: ["c-weird"] }),
    ]);
    const text = serializeBlocksToDialect(all, weirdChars);
    expect(text).toContain("#c-weird：");
    expect(text).not.toContain("旁：白、员"); // 字面名绝不出现在结构位
    const rt = applyWith(all, text, weirdChars);
    if (!rt.ok) throw new Error(JSON.stringify(rt.errors));
    expect(diffState({ ...st(all), characters: weirdChars }, { ...st(rt.blocks), characters: weirdChars }, 1).blockOps).toEqual([]);

    const ins = applyWith(all, `${text}\n[new] #c-weird（急）：新台词`, weirdChars);
    if (!ins.ok) throw new Error(JSON.stringify(ins.errors));
    const nb = ins.blocks.find((b) => b.id === "nb1")!;
    expect(nb.characterIds).toEqual(["c-weird"]);
    expect(nb.characterAnnotations).toEqual({ "c-weird": "急" });
  });

  it("括注含顿号与括号：括号转义、顿号靠深度保护，往返空 diff", () => {
    const all = canon([
      mkMarker("m-ch", "chapter_marker", "一", null),
      mkText("d1", "合", {
        characterIds: ["c-zhang"],
        characterAnnotations: { "c-zhang": "与乙、丙（合）说" },
      }),
    ]);
    const text = serializeBlocksToDialect(all, chars);
    expect(text).toContain("\\（合\\）");
    const rt = applyWith(all, text, chars);
    if (!rt.ok) throw new Error(JSON.stringify(rt.errors));
    expect(diffState(st(all), st(rt.blocks), 1).blockOps).toEqual([]);
  });

  it("「张三（甲、乙）」是一个带括注的说话人，不被顿号切开", () => {
    const all = canon([mkMarker("m-ch", "chapter_marker", "一", null), mkText("d1", "x")]);
    const res = applyWith(all, `[m:m-ch] #\n[b:d1] [白] x\n[new] 张三（甲、乙）：合说`, chars);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const nb = res.blocks.find((b) => b.id === "nb1")!;
    expect(nb.characterIds).toEqual(["c-zhang"]);
    expect(nb.characterAnnotations).toEqual({ "c-zhang": "甲、乙" });
  });

  it("未知 #id 报错；marker 标题含换行被折叠、不撕破行结构", () => {
    const all = canon([
      mkMarker("m-ch", "chapter_marker", "", null),
      mkText("d1", "x"),
    ]);
    (all[0].markerMeta as { name?: string }).name = "第一\n幕";
    const text = serializeBlocksToDialect(all, chars);
    expect(text.split("\n")[0]).toContain("第一 幕");
    const rt = applyWith(all, text, chars);
    if (!rt.ok) throw new Error(JSON.stringify(rt.errors));

    const bad = applyWith(all, `${text}\n[new] #no-such：谁`, chars);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.message).join()).toContain("#no-such");
  });
});

describe("说明书常量", () => {
  it("覆盖全部标记词（三落点同批：文法变这里必须同批变）", () => {
    for (const token of ["[b:<id>]", "[new]", "[m:<id>]", "[台]", "[白]", "[歌]", "[显名]", "[提示]"]) {
      expect(SCRIPT_DIALECT_NOTE).toContain(token);
    }
  });
});
