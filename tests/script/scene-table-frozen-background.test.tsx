import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync("components/script/SceneTableView.tsx", "utf8");
const globals = readFileSync("app/globals.css", "utf8");

describe("#643 构作表格冻结列背景", () => {
  it("冻结列跟随行状态，而不是写死白色内联背景", () => {
    expect(component).not.toContain('backgroundColor: "#fff"');
    expect(component).toContain("scene-table-row-chapter");
    expect(component).toContain("scene-table-frozen-cell");
    expect(component).toContain("scene-table-frozen-header");
  });

  it("四种行状态都提供不透明背景，冻结层不会透出滚动内容", () => {
    expect(globals).toMatch(/\.scene-table-row\s*{[^}]*--scene-table-row-bg:\s*#fff/);
    expect(globals).toMatch(/\.scene-table-row:hover\s*{[^}]*--scene-table-row-bg:\s*color-mix\(in oklab, var\(--color-zinc-100\) 70%, white\)/);
    expect(globals).toMatch(/\.scene-table-row\.scene-table-row-chapter\s*{[^}]*--scene-table-row-bg:\s*color-mix\(in oklab, var\(--color-zinc-50\) 70%, white\)/);
    expect(globals).toMatch(/\.scene-table-row\.scene-table-row-chapter:hover\s*{[^}]*--scene-table-row-bg:\s*var\(--color-zinc-100\)/);
    expect(globals).toMatch(/\.scene-table-frozen-cell\s*{[^}]*background-color:\s*var\(--scene-table-row-bg, #fff\)/);
  });
});
