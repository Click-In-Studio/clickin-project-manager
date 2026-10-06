// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CharacterDetailView from "@/components/script/CharacterDetail";
import {
  dramaturgyWorkspaceModeStorageKey,
  useDramaturgyWorkspaceMode,
} from "@/components/script/use-dramaturgy-workspace-mode";
import { ALL_CHARACTER_PERMS } from "@/lib/script/character-perms-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
  productionId = "prod-a",
  canEdit = true,
  save = async () => {},
  dirty = false,
}: {
  productionId?: string;
  canEdit?: boolean;
  save?: (value: string) => Promise<void>;
  dirty?: boolean;
}) {
  const workspace = useDramaturgyWorkspaceMode(productionId, canEdit);
  return (
    <div>
      <output data-testid="mode">{workspace.mode}</output>
      <output data-testid="error">{workspace.error ?? ""}</output>
      {workspace.mode === "edit" && (
        <input
          defaultValue="未保存草稿"
          onBlur={(event) => { void workspace.trackWrite(save(event.currentTarget.value)).catch(() => {}); }}
        />
      )}
      {dirty && (
        <div
          data-dramaturgy-unsaved="true"
          data-dramaturgy-unsaved-message="请先处理草稿"
        >
          <button type="button">草稿</button>
        </div>
      )}
      <button data-action="read" type="button" onClick={() => { void workspace.requestMode("read"); }}>只读</button>
      <button data-action="edit" type="button" onClick={() => { void workspace.requestMode("edit"); }}>编辑</button>
    </div>
  );
}

describe("构作工作区只读/编辑模式", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = async (node: ReactNode) => {
    await act(async () => { root.render(node); });
  };
  const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent;
  const click = async (label: string) => {
    const action = label === "只读" ? "read" : "edit";
    const button = host.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!;
    await act(async () => { button.click(); await Promise.resolve(); });
  };

  it("有写权限默认编辑，并按项目记住只读偏好", async () => {
    await render(<Harness />);
    expect(text("mode")).toBe("edit");

    await click("只读");
    expect(text("mode")).toBe("read");
    expect(localStorage.getItem(dramaturgyWorkspaceModeStorageKey("prod-a"))).toBe("read");

    await render(<Harness productionId="prod-b" />);
    await render(<Harness />);
    expect(text("mode")).toBe("read");
  });

  it("无写权限始终只读，且不覆盖本人已保存的编辑偏好", async () => {
    localStorage.setItem(dramaturgyWorkspaceModeStorageKey("prod-a"), "edit");
    await render(<Harness canEdit={false} />);
    expect(text("mode")).toBe("read");
    expect(localStorage.getItem(dramaturgyWorkspaceModeStorageKey("prod-a"))).toBe("edit");
  });

  it("切只读前等待失焦保存；保存失败则保留编辑态和输入", async () => {
    let rejectSave!: (error: Error) => void;
    const save = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    await render(<Harness save={save} />);
    const input = host.querySelector("input")!;
    input.focus();

    const readButton = host.querySelector<HTMLButtonElement>('button[data-action="read"]')!;
    act(() => { readButton.click(); });
    expect(save).toHaveBeenCalledWith("未保存草稿");
    await act(async () => {
      rejectSave(new Error("网络中断，保存失败"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text("mode")).toBe("edit");
    expect(text("error")).toContain("网络中断");
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("未保存草稿");
  });

  it("失焦保存已经失败后再切只读，仍保留编辑态和草稿", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("稍早的保存失败"))
      .mockResolvedValue(undefined);
    await render(<Harness save={save} />);
    const input = host.querySelector("input")!;
    input.focus();

    await act(async () => {
      input.blur();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text("error")).toContain("稍早的保存失败");

    await click("只读");
    expect(text("mode")).toBe("edit");
    expect(text("error")).toContain("稍早的保存失败");
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("未保存草稿");

    input.focus();
    await act(async () => {
      input.blur();
      await Promise.resolve();
      await Promise.resolve();
    });
    await click("只读");
    expect(text("mode")).toBe("read");
  });

  it("新增表单仍有草稿时阻止切只读", async () => {
    await render(<Harness dirty />);
    await click("只读");
    expect(text("mode")).toBe("edit");
    expect(text("error")).toBe("请先处理草稿");
  });

  it("角色详情真实字段保存失败时不切只读，并保留输入", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "角色保存失败" }),
    }));
    await render(
      <CharacterDetailView
        productionId="prod-a"
        productionName="测试制作"
        character={{
          id: "char-a",
          name: "旧名字",
          isAggregate: false,
          memberIds: [],
          gender: "",
          biography: "",
          roleType: "",
        }}
        allCharacters={[]}
        perms={ALL_CHARACTER_PERMS}
      />,
    );

    const input = host.querySelector<HTMLInputElement>("input")!;
    input.focus();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      valueSetter.call(input, "未保存的新名字");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "read";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(host.querySelector("[role='alert']")?.textContent).toContain("角色保存失败"));

    expect(host.querySelector('[role="combobox"][aria-label="页面模式"]')?.textContent).toContain("编辑");
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("未保存的新名字");
  });
});

describe("模式门与原有细粒度权限相交", () => {
  it("场次列表、表格和附件关联仍逐字段/实例判定", () => {
    const list = readFileSync("components/script/ScenesManager.tsx", "utf8");
    const table = readFileSync("components/script/SceneTableView.tsx", "utf8");
    expect(list).toContain("canEdit && fieldPerms.create");
    expect(list).toContain("canEdit && canDeleteScene(fieldPerms, act.id)");
    expect(list).toContain("canEdit && canMountScene(fieldPerms, scene.id)");
    expect(table).toContain("canEdit && fieldPerms.synopsis");
    expect(table).toContain("canEdit && canMountScene(fieldPerms, scene.id)");
  });

  it("角色列表和详情继续使用逐动作、逐实例权限", () => {
    const list = readFileSync("components/script/CharactersManager.tsx", "utf8");
    const detail = readFileSync("components/script/CharacterDetail.tsx", "utf8");
    const page = readFileSync("app/production/[id]/characters/[charId]/page.tsx", "utf8");
    expect(list).toContain("contentEditable && canEditCharacter(perms, c.id)");
    expect(list).toContain("contentEditable && canDeleteCharacter(perms, c.id)");
    expect(detail).toContain("canEditCharacter(perms, initial.id)");
    expect(detail).toContain("canDeleteCharacter(perms, initial.id)");
    expect(page).toContain("getCharacterPerms(");
  });

  it("窄屏阶段把模式入口收进更多菜单，详情页项目名允许收缩", () => {
    const dramaturgy = readFileSync("components/script/Dramaturgy.tsx", "utf8");
    const characters = readFileSync("components/script/CharactersManager.tsx", "utf8");
    const detail = readFileSync("components/script/CharacterDetail.tsx", "utf8");
    for (const source of [dramaturgy, characters]) {
      expect(source).toContain("toolbarStage >= PRODUCTION_TOOLBAR_STAGE.primaryStored");
      expect(source).toContain("toolbarStage < PRODUCTION_TOOLBAR_STAGE.primaryStored");
      expect(source).toContain("页面模式");
    }
    expect(detail).toContain('className="truncate text-sm font-bold text-zinc-500"');
  });
});
