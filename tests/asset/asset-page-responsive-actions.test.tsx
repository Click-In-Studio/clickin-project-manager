// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AssetPageClient from "@/components/assets/AssetPageClient";
import AssetShareModal from "@/components/assets/AssetShareModal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

vi.mock("@/components/shell/ProductionModuleTopMenu", () => ({
  default: ({ label }: { label: string }) => <header>{label}</header>,
  PRODUCTION_MODULE_ACTION_CLASS: "primary-action",
  PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS: "overflow-action",
}));

vi.mock("@/components/assets/AssetUploadPanel", () => ({
  default: () => <div data-testid="upload-panel">上传面板</div>,
}));

vi.mock("@/components/wiki/RelatedWikiChips", () => ({
  default: () => <div>关联文档</div>,
}));

vi.mock("@/components/assets/AssetAccessModal", () => ({
  default: () => <div data-testid="internal-share-panel">对内分享面板</div>,
}));

vi.mock("@/components/assets/AssetSharePanel", () => ({
  default: () => <div data-testid="external-share-panel">对外链接面板</div>,
}));

const css = readFileSync("components/assets/assets-page.module.css", "utf8");

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")]
    .find(candidate => candidate.textContent?.trim() === label
      || candidate.querySelector("span")?.textContent?.trim() === label);
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const asset = {
  id: "asset-1",
  productionId: "production-1",
  uploaderUserId: "uploader-1",
  assetType: "reference",
  name: "不会因为窄屏而被省略的完整资产名称与第二行信息",
  fileName: "舞台机械系统终版设计图纸.pdf",
  mimeType: "application/pdf",
  storageType: "feishu_link",
  fileVersionPolicy: "append",
  feishuUrl: "https://example.feishu.cn/file/1",
  createdAt: "2026-10-03T00:00:00.000Z",
  nodeId: "node-1",
  listable: false,
  treePath: ["技术部", "舞美"],
  sizeBytes: 4 * 1024 * 1024,
  actions: {
    metaEdit: false,
    delete: false,
    addVersion: false,
    download: true,
    share: false,
    unmount: false,
    externalShare: true,
    externalShareCreate: false,
    listableOn: false,
    listableOff: false,
  },
};

describe("资产工作台响应式信息与动作", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      assets: [asset], stats: { totalBytes: asset.sizeBytes, unknownFiles: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("319、385、645 进入窄屏布局，桌面恢复同行动作；筛选按钮始终单行", () => {
    for (const width of [319, 385, 645]) expect(width).toBeLessThanOrEqual(720);
    expect(1280).toBeGreaterThan(720);
    expect(css).toMatch(/\.searchInput\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?flex:\s*1 1 auto;/);
    expect(css).toMatch(/\.filterTabs\s*\{[\s\S]*?flex:\s*0 0 auto;/);
    expect(css).toMatch(/\.filterTab\s*\{[\s\S]*?white-space:\s*nowrap;/);
    expect(css).toMatch(/\.assetName\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*normal;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 320px\)[\s\S]*?padding:\s*20px 10px 52px/);
  });

  it("保留完整名称、文件名、类型、大小与位于其后的飞书来源标签", async () => {
    await act(async () => {
      root.render(<AssetPageClient productionId="production-1" versionId={null}
        myUserId="viewer-1" userName="查看者" members={[]} departments={[]} />);
    });
    await act(async () => {});

    expect(container.textContent).toContain(asset.name);
    expect(container.textContent).toContain(asset.fileName);
    const sourceTag = [...container.querySelectorAll("span")]
      .find(node => node.textContent === "飞书");
    const meta = sourceTag?.parentElement;
    expect(meta).toBeTruthy();
    expect(meta!.textContent!.indexOf("参考资料")).toBeLessThan(meta!.textContent!.indexOf("4.0 MB"));
    expect(meta!.textContent!.indexOf("4.0 MB")).toBeLessThan(meta!.textContent!.indexOf("飞书"));
  });

  it("下载、编辑、删除、分享按优先级常驻；无权限动作置灰并在更多中保留新版本", async () => {
    await act(async () => {
      root.render(<AssetPageClient productionId="production-1" versionId={null}
        myUserId="viewer-1" userName="查看者" members={[]} departments={[]} />);
    });
    await act(async () => {});

    const labels = [...container.querySelectorAll("button")]
      .map(candidate => candidate.textContent?.trim())
      .filter(label => ["下载", "编辑", "删除", "分享"].includes(label ?? ""));
    expect(labels).toEqual(["下载", "编辑", "删除", "分享"]);
    expect(button(container, "下载").getAttribute("aria-disabled")).toBe("false");
    expect(button(container, "编辑").getAttribute("aria-disabled")).toBe("true");
    expect(button(container, "编辑").title).toBe("需要资产元数据编辑权");
    expect(button(container, "删除").getAttribute("aria-disabled")).toBe("true");
    expect(button(container, "分享").getAttribute("aria-disabled")).toBe("false");

    await click(button(container, "更多"));
    const versionActions = [...container.querySelectorAll("button")]
      .filter(candidate => candidate.textContent?.trim() === "新版本");
    expect(versionActions).toHaveLength(2);
    expect(versionActions.every(candidate => candidate.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(versionActions[1].title).toBe("需要文件版本创建权");
    expect(button(container, "查看关联详情")).toBeTruthy();
  });
});

describe("统一分享入口", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("初始只显示对内与对外入口，并复用对应现有面板", async () => {
    await act(async () => {
      root.render(<AssetShareModal productionId="production-1" assetId="asset-1" assetName="设计图"
        userName="分享者" members={[]} departments={[]}
        canShareInternally={false} canManageExternalShare canCreateExternalShare={false}
        onClose={() => {}} />);
    });

    expect(container.querySelector('[data-testid="internal-share-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-share-panel"]')).toBeNull();
    expect(button(container, "对内分享").getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("需要该资产的授权管理权");
    expect(button(container, "对外链接").getAttribute("aria-disabled")).toBe("false");

    await click(button(container, "对内分享"));
    expect(container.querySelector('[data-testid="internal-share-panel"]')).toBeNull();
    await click(button(container, "对外链接"));
    expect(container.querySelector('[data-testid="external-share-panel"]')).not.toBeNull();
  });
});
