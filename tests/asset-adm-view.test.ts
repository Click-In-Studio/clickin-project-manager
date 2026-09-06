import { describe, it, expect } from "vitest";
import { pickAdmView, metaInfoLine } from "@/components/assets/AssetPreviewClient";

// #444：ADM 展示面的纯函数——喂进来的是解析自 BWF/sidecar 的外部数据，
// 畸形/缺字段形态要稳（AI review 建议补测）。

const env = (data: Record<string, unknown> | null) => ({
  status: "ok", detectedType: "audio/wav", data, sidecarKey: null,
});

describe("pickAdmView", () => {
  it("完整形态：规格 + programme + 对象清单", () => {
    const v = pickAdmView(env({
      channels: 70, sampleRate: 48000, bitDepth: 24, durationSeconds: 94.125,
      adm: { objectCount: 61, trackUidCount: 70, programmes: [{ name: "Atmos_Master" }], objectsTruncated: false },
      admObjects: [{ name: "Standard Bed 7.1.2" }],
    }));
    expect(v).toMatchObject({
      channels: 70, objectCount: 61, trackUidCount: 70, durationSeconds: 94.125, objectsTruncated: false,
    });
    expect(v?.programmes[0]?.name).toBe("Atmos_Master");
    expect(v?.objects).toHaveLength(1);
  });

  it("非 ADM / 空 data / null 信封 → null（不误开面板）", () => {
    expect(pickAdmView(env({ channels: 2 }))).toBeNull();
    expect(pickAdmView(env(null))).toBeNull();
    expect(pickAdmView(null)).toBeNull();
  });

  it("畸形字段不崩：admObjects 非数组、objectCount 缺失、programmes 非数组", () => {
    const v = pickAdmView(env({
      adm: { objectCount: "61", programmes: "bad" },
      admObjects: "not-an-array",
    }));
    expect(v).toMatchObject({ objectCount: 0, programmes: [], objects: [], objectsTruncated: false });
    expect(v?.channels).toBeUndefined();
    expect(v?.durationSeconds).toBeNull();
  });
});

describe("metaInfoLine 的 ADM 身份优先", () => {
  it("有 adm 数据时首徽标是「ADM 母版」而非 WAV", () => {
    const line = metaInfoLine(env({ adm: { objectCount: 61 }, channels: 70, sampleRate: 48000, bitDepth: 24 }), 951_000_000);
    expect(line?.startsWith("ADM 母版")).toBe(true);
    expect(line).toContain("ADM 61 对象");
  });

  it("普通 wav 仍是类型标签打头", () => {
    expect(metaInfoLine(env({ sampleRate: 48000, bitDepth: 24 }), 1000)?.startsWith("WAV 音频")).toBe(true);
  });
});
