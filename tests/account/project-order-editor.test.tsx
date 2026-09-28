// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import ProjectOrderEditor, { moveProjectRelative } from "@/components/account/ProjectOrderEditor";
import type { MyProductionEntry } from "@/lib/production/production-db";

const project = (id: string): MyProductionEntry => ({
  id, name: id, createdAt: new Date().toISOString(), archivedAt: null,
  roles: [], firstTag: null, avatarUrl: null, isOwner: true,
  hasAdminPerm: true, planTier: "free",
});

describe("moveProjectRelative", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("按锚点前后移动而不丢项", () => {
    expect(moveProjectRelative(items, "c", { anchorId: "a", side: "before" }).map(x => x.id)).toEqual(["c", "a", "b"]);
    expect(moveProjectRelative(items, "a", { anchorId: "c", side: "after" }).map(x => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("ProjectOrderEditor 键盘排序", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    refresh.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("方向键乐观换位并提交相对锚点，成功后刷新 shell 顺序", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      { ok: true, json: async () => ({ ok: true }) }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const onOrderChange = vi.fn();
    await act(async () => {
      root.render(<ProjectOrderEditor projects={[project("a"), project("b"), project("c")]} onOrderChange={onOrderChange} />);
    });
    const handle = container.querySelector<HTMLButtonElement>('button[aria-label^="拖动《b》"]')!;
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      productionId: "b", place: { anchorId: "a", side: "before" },
    });
    expect(onOrderChange.mock.calls[0][0].map((item: MyProductionEntry) => item.id)).toEqual(["b", "a", "c"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
