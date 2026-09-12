// 引用 URI 的编解码。
//
// 这层此前**零直接测试**（AI review 抓到的），但 decodeMentionHref 是渲染管线
// 与保真锁的核心：编辑器 parseHTML、WikiMarkdown 的 a 分派、mention 批量 resolve
// 全走它。而它还带一条 v1 只读兼容分支（历史版本 wiki_revision 不迁移），
// 那条分支靠字符串拼接复用 deserializeMention——deserializeMention 的内层文法
// 一旦独立演进，这里会**静默**失配。所以 v1 的每种形态都要钉住。
import { describe, it, expect } from "vitest";
import {
  encodeMentionHref, decodeMentionHref,
  encodeUserHref, decodeUserHref,
  encodeAssetSrc, decodeAssetSrc,
  type ContentMentionAttrs,
} from "@/lib/mention-types";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const attrs = (o: Partial<ContentMentionAttrs>): ContentMentionAttrs => ({
  kind: "wiki", displayMode: null, id: UUID, aux: null, versionId: null, ...o,
});

describe("v2 形态 round-trip", () => {
  const cases: [string, ContentMentionAttrs][] = [
    ["裸引用", attrs({})],
    ["版本钉住", attrs({ kind: "scene", id: "sc_a", versionId: "ver_7" })],
    ["block + 展示模式", attrs({ kind: "block", id: "blk_9", displayMode: "page" })],
    ["asset + aux", attrs({ kind: "asset", id: "as_7", aux: "scene" })],
    ["三参数齐全", attrs({ kind: "block", id: "b1", displayMode: "scene", aux: "x", versionId: "v2" })],
  ];
  for (const [name, a] of cases) {
    it(`${name}：decode(encode(x)) === x`, () => {
      expect(decodeMentionHref(encodeMentionHref(a))).toEqual(a);
    });
  }

  it("参数顺序 canonical（as → v → aux），serializer 幂等", () => {
    const href = encodeMentionHref(attrs({ kind: "block", id: "b1", displayMode: "scene", aux: "x", versionId: "v2" }));
    expect(href).toBe("/__cm__/block/b1?as=scene&v=v2&aux=x");
    expect(encodeMentionHref(decodeMentionHref(href)!)).toBe(href);
  });

  it("锚点 fragment 可解析且不干扰实体身份（PR A 只预留语法位）", () => {
    expect(decodeMentionHref(`/__cm__/wiki/${UUID}#a3f9`)).toEqual(attrs({}));
  });
});

describe("v1 只读兼容——历史版本正文不迁移，每种形态都要认得", () => {
  it("kind:id", () => {
    expect(decodeMentionHref(`/__cm__wiki:${UUID}`)).toEqual(attrs({}));
  });
  it("kind:id?v=", () => {
    expect(decodeMentionHref("/__cm__scene:sc_a?v=ver_7"))
      .toEqual(attrs({ kind: "scene", id: "sc_a", versionId: "ver_7" }));
  });
  it("kind:id:aux", () => {
    expect(decodeMentionHref("/__cm__asset:as_7:scene"))
      .toEqual(attrs({ kind: "asset", id: "as_7", aux: "scene" }));
  });
  it("block.<mode>:id 点号语法", () => {
    expect(decodeMentionHref("/__cm__block.page:blk_9"))
      .toEqual(attrs({ kind: "block", id: "blk_9", displayMode: "page" }));
  });
  it("非引用 href 返回 null", () => {
    expect(decodeMentionHref("https://example.com/a")).toBeNull();
    expect(decodeMentionHref("/production/p1/wiki/x")).toBeNull();
  });
  it("残缺的私有 href 返回 null，不抛", () => {
    expect(decodeMentionHref("/__cm__garbage")).toBeNull();
  });
});

describe("鲁棒性（AI review 指出的两处）", () => {
  it("id 编解码对称：含保留字符的 id 也能 round-trip", () => {
    const a = attrs({ kind: "cue", id: "LX/1?x=2#y" });
    expect(decodeMentionHref(encodeMentionHref(a))).toEqual(a);
  });

  it("损坏的百分号序列不抛异常——坏正文不该炸掉整页渲染", () => {
    expect(() => decodeMentionHref("/__cm__/wiki/%zz")).not.toThrow();
    expect(decodeMentionHref("/__cm__/wiki/%zz")?.id).toBe("%zz");
  });

  it("非法 ?as= 落回 null，不静默造出坏 displayMode", () => {
    expect(decodeMentionHref("/__cm__/block/b1?as=bogus")?.displayMode).toBeNull();
    // 坏值若被放行，会随 encode 写回正文自我传播
    expect(encodeMentionHref(decodeMentionHref("/__cm__/block/b1?as=bogus")!))
      .toBe("/__cm__/block/b1");
  });

  it("as= 只对 block 生效（其他 type 带了也忽略）", () => {
    expect(decodeMentionHref("/__cm__/wiki/x?as=page")?.displayMode).toBeNull();
  });
});

describe("user / asset 的独立出入口", () => {
  it("user href round-trip；contentMention 分支不认它", () => {
    expect(decodeUserHref(encodeUserHref("u_1"))).toBe("u_1");
    expect(decodeMentionHref("/__cm__/user/u_1")).toBeNull();
  });
  it("旧 uid: scheme 仍可读（编辑器 parseHTML 路径无 sanitizer）", () => {
    expect(decodeUserHref("uid:u_9")).toBe("u_9");
  });
  it("asset src round-trip 且新旧双读", () => {
    expect(decodeAssetSrc(encodeAssetSrc("as_1"))).toBe("as_1");
    expect(decodeAssetSrc("/__cm__asset:as_1")).toBe("as_1");
    expect(decodeAssetSrc("/__cm__/wiki/x")).toBeNull();
  });
});
