// @vitest-environment jsdom
//
// #593：资源申请页点「批准」后没有任何反应，但后端其实已经批准。两个缺陷叠在一起：
// 1. 按钮只加 disabled，PRIMARY_BTN 没有 disabled 外观、文案也不变，网络慢时看不出在处理；
// 2. 成功后只重拉列表、不写回右侧面板，而面板同步 effect 只在列表里还找得到这条申请时
//    才替换——批准后它已从「待审批」消失，面板就永远停在旧快照（「批准」按钮又能点，
//    再点得 409）。
// 这里钉的是：在途时按钮灰掉写「处理中…」且连点不发第二个 POST；成功后面板显示终态；
// 转交到下一级（仍在等待）时面板关掉；服务端拒绝 / 网络错误在面板里写出原因并恢复按钮。
// 反证：把 runAction 里 setRightPanel 那段去掉，「面板显示终态」红；把 ActionButton 的
// busy 文案去掉，「处理中…」红；去掉 catch，网络错误那条红。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ApprovalRequest } from "@/lib/approval/access-request-db";

// 流程设置页签（模版设计器）与本测试无关
vi.mock("@/components/approval/ApprovalFlowDesigner", () => ({ default: () => null }));

import AccessRequestsClient from "@/components/approval/AccessRequestsClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-09-24T02:00:00.000Z";

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "ar_1", productionId: "prod_test", subjectId: "u_sub", subjectName: "李四",
    type: "access", resourceType: "cue_list", resourceId: "*", resourceSub: null,
    permissionLevel: "view", grantType: "permanent", ttlDurationLabel: null, requestedExpiresAt: null,
    note: "要看 Cue 表", status: "pending_supervisor",
    escalationChain: [{ phase: "supervisor", stage: "supervisor", depth: 0, canFinalize: true, approverIds: ["u_me"], notifiedAt: NOW }],
    flowSnapshot: null, currentStage: "supervisor", currentApproverIds: ["u_me"], canFinalize: true,
    createdAt: NOW, resolvedAt: null, resolvedBy: null, grantedAt: null, expiresAt: null,
    people: {
      u_me:  { userId: "u_me",  name: "王五", roles: ["producer"], isMember: true },
      u_sub: { userId: "u_sub", name: "李四", roles: [], isMember: true },
    },
    ...over,
  };
}

/** 「待审批」列表的服务端状态：批准 / 转交后这条申请就不在里面了。 */
let pending: ApprovalRequest[] = [];
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
const jsonRes = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  pending = [request()];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url) => {
    if (url.endsWith("/pending-approvals")) return jsonRes({ approvals: pending });
    if (url.endsWith("/access-requests")) return jsonRes({ requests: [] });
    if (url.endsWith("/flow")) return jsonRes({ error: "nope" }, 404);
    throw new Error(`unexpected fetch ${url}`);
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
/** 右侧详情面板：只有 RequestDetail 渲染 h2。 */
const detailPane = () => container.querySelector("h2")?.parentElement ?? null;
const detailButton = (label: string) =>
  Array.from(detailPane()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent === label);
const postCalls = (suffix: string) =>
  fetchMock.mock.calls.filter(([url, init]) => init?.method === "POST" && url.endsWith(suffix));

/** 挂载 → 切到「待审批」→ 在桌面列表里选中这条申请（列表项带申请人前缀，手机卡片不带）。 */
async function mountAndSelect() {
  await act(async () => { root.render(<AccessRequestsClient productionId="prod_test" productionName="测试演出" canManageFlows={false} />); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { buttons().find((b) => b.textContent?.startsWith("待审批"))!.click(); });
  await act(async () => { buttons().find((b) => b.textContent?.includes("李四 · Cue表"))!.click(); });
  expect(detailButton("批准")).toBeDefined();
}

/** 让 approve 请求挂起，返回 resolve 句柄。 */
function holdApprove() {
  let resolve!: (v: unknown) => void;
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => {
    if (url.endsWith("/approve") && init?.method === "POST") return new Promise((r) => { resolve = r; });
    return base(url, init);
  });
  return () => resolve;
}

describe("AccessRequestsClient — 审批动作的在途态与结果反馈（#593）", () => {
  it("请求在途：「批准」灰掉写「处理中…」、兄弟按钮一起锁、连点不发第二个 POST", async () => {
    const getResolve = holdApprove();
    await mountAndSelect();

    await act(async () => { detailButton("批准")!.click(); });
    const busy = detailButton("处理中…")!;
    expect(busy).toBeDefined();
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(detailButton("拒绝")!.disabled).toBe(true);
    expect(detailButton("向上转交")!.disabled).toBe(true);

    await act(async () => { busy.click(); });
    expect(postCalls("/approve")).toHaveLength(1);

    pending = [];
    await act(async () => {
      getResolve()({ ok: true, status: 200, json: () => Promise.resolve({ request: request({ status: "approved", resolvedAt: NOW, resolvedBy: "u_me", grantedAt: NOW, canFinalize: null }) }) });
    });
    // 面板显示终态、动作按钮消失；列表里它已不在
    expect(detailPane()!.textContent).toContain("已批准");
    expect(detailButton("批准")).toBeUndefined();
    expect(detailButton("处理中…")).toBeUndefined();
    expect(container.textContent).toContain("暂无待审批申请");
  });

  it("转交到下一级：申请仍在等待但已不归我管，面板关掉而不是留着「批准」可点", async () => {
    await mountAndSelect();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (url.endsWith("/escalate") && init?.method === "POST") {
        pending = [];
        return jsonRes({ request: request({ status: "pending_resource", currentStage: "holder", currentApproverIds: ["u_other"], canFinalize: null }) });
      }
      return base(url, init);
    });

    await act(async () => { detailButton("向上转交")!.click(); });
    expect(detailPane()).toBeNull();
    expect(container.textContent).toContain("选择左侧申请进行审批");
  });

  it("服务端拒绝（409）：面板里写出原因，按钮恢复可点", async () => {
    await mountAndSelect();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (url.endsWith("/approve") && init?.method === "POST") return jsonRes({ error: "申请已被他人处理" }, 409);
      return base(url, init);
    });

    await act(async () => { detailButton("批准")!.click(); });
    expect(container.textContent).toContain("申请已被他人处理");
    expect(detailButton("批准")!.disabled).toBe(false);
  });

  it("网络错误（fetch 拒绝）：写「网络错误」并恢复按钮，不成为未处理 rejection", async () => {
    await mountAndSelect();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (url.endsWith("/reject") && init?.method === "POST") return Promise.reject(new TypeError("Failed to fetch"));
      return base(url, init);
    });

    await act(async () => { detailButton("拒绝")!.click(); });
    expect(container.textContent).toContain("网络错误");
    expect(detailButton("拒绝")!.disabled).toBe(false);
    expect(detailButton("拒绝")!.textContent).toBe("拒绝");
  });
});
