import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync("components/wiki/WikiShell.tsx", "utf8");
const page = readFileSync("app/production/[id]/wiki/[wikiId]/page.tsx", "utf8");
describe("最近访问与正文权限门接线", () => {
  it("仅正文成功分支传 canonical id；资产与无权页不记录访问", () => {
    expect(page.match(/recentWikiId=/g)).toHaveLength(1);
    const authorized = page.slice(page.indexOf("const [canEdit, canShare"));
    expect(authorized).toContain("recentWikiId={docId}");
    expect(authorized).toContain("<WikiDocClient");
    expect(page).toContain("const docId = linkTarget?.wikiId ?? wikiId;");
    expect(page.indexOf("if (!canView)")).toBeLessThan(page.indexOf("recentWikiId={docId}"));
  });
  it("入口在搜索与新建之间，灵感工作区不纳入本次范围", () => {
    expect(shell.indexOf('placeholder="搜索文档 / 标签…"')).toBeLessThan(shell.indexOf("<WikiRecentVisits"));
    expect(shell.indexOf("<WikiRecentVisits")).toBeLessThan(shell.indexOf("＋ 新建\n"));
    expect(shell).toContain("{!navigationBasePath && <WikiRecentVisits");
    expect(shell).toContain("onNavigate={() => setMobileTreeOpen(false)}");
  });
});
