import { describe, it, expect } from "vitest";
import { isSystemJunkPath, buildArchiveTree, flattenTree, allDirPaths } from "@/lib/asset/archive-view";

// #85：压缩包展示层——Mac 垃圾识别 + 树形组装（数据层清单保持完整，隐藏只在展示）。

describe("isSystemJunkPath", () => {
  it("macOS 打包垃圾全家：__MACOSX 树、.DS_Store、._AppleDouble", () => {
    expect(isSystemJunkPath("__MACOSX/")).toBe(true);
    expect(isSystemJunkPath("__MACOSX/Proj/._show.als")).toBe(true);
    expect(isSystemJunkPath("Proj/.DS_Store")).toBe(true);
    expect(isSystemJunkPath("Proj/._主题曲.wav")).toBe(true);
    expect(isSystemJunkPath("Thumbs.db")).toBe(true);
  });

  it("正常文件不误伤（含点开头的非垃圾与 _ 开头目录）", () => {
    expect(isSystemJunkPath("Proj/.gitignore")).toBe(false);
    expect(isSystemJunkPath("_archive/old.wav")).toBe(false);
    expect(isSystemJunkPath("音乐/主题曲.wav")).toBe(false);
  });
});

describe("buildArchiveTree", () => {
  const entries = [
    { path: "Proj/", isDirectory: true },
    { path: "Proj/audio/a.wav", uncompressedBytes: 100 },
    { path: "Proj/audio/b.wav", uncompressedBytes: 200 },
    { path: "Proj/show.qlab5", uncompressedBytes: 50 },
    { path: "readme.txt", uncompressedBytes: 10 },
    { path: "docs/", isDirectory: true },            // 显式空目录
    { path: "Proj/.DS_Store", uncompressedBytes: 6 },
    { path: "__MACOSX/Proj/._show.qlab5", uncompressedBytes: 300 },
  ];

  it("路径段推导文件夹 + 目录聚合尺寸 + 目录在前排序 + 垃圾默认隐藏", () => {
    const { roots, hiddenCount, visibleFileCount } = buildArchiveTree(entries);
    expect(hiddenCount).toBe(2);
    expect(visibleFileCount).toBe(4);
    expect(roots.map((n) => `${n.isDir ? "D" : "F"}:${n.name}`)).toEqual(["D:docs", "D:Proj", "F:readme.txt"]);
    const proj = roots[1];
    expect(proj.sizeBytes).toBe(350); // 100+200+50，垃圾不计
    expect(proj.children.map((n) => n.name)).toEqual(["audio", "show.qlab5"]);
    expect(proj.children[0].sizeBytes).toBe(300);
  });

  it("同名目录/文件双面（畸形 zip）不许文件覆盖目录节点丢子树", () => {
    const { roots } = buildArchiveTree([
      { path: "x/a.wav", uncompressedBytes: 10 },
      { path: "x", uncompressedBytes: 5 }, // 与目录 x 同名的文件
    ]);
    const names = roots.map((n) => `${n.isDir ? "D" : "F"}:${n.name}`);
    expect(names).toEqual(["D:x", "F:x"]); // 两面并存，子树不丢
    expect(roots[0].children).toHaveLength(1);
  });

  it("showJunk 时垃圾回到树里", () => {
    const { roots, hiddenCount } = buildArchiveTree(entries, { hideJunk: false });
    expect(hiddenCount).toBe(0);
    expect(roots.some((n) => n.name === "__MACOSX")).toBe(true);
  });

  it("flatten 受折叠控制 / allDirPaths 收集", () => {
    const { roots } = buildArchiveTree(entries);
    const dirs = allDirPaths(roots);
    expect(dirs.sort()).toEqual(["Proj", "Proj/audio", "docs"]);
    expect(flattenTree(roots, new Set()).map((r) => r.node.name)).toEqual(["docs", "Proj", "readme.txt"]);
    const all = flattenTree(roots, new Set(dirs));
    expect(all.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:docs", "0:Proj", "1:audio", "2:a.wav", "2:b.wav", "1:show.qlab5", "0:readme.txt",
    ]);
  });
});
