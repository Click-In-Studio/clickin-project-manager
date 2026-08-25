/**
 * 审批时间线组装（lib/approval-timeline）—— 纯函数，喂构造好的申请对象。
 *
 * 这里钉的全是「页面上极难手工复现」的分支：要等 24 小时才看得到超时升级、
 * 要造存量行才看得到无链降级、要连提两条申请才看得到覆盖终结。这些恰恰是
 * 此前渲染错得最离谱的地方——超时理由一个字都显示不出来、撤回后的那一级
 * 画成灰点像「还在等」。
 */
import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { buildApprovalTimeline } from "@/lib/approval-timeline";
import type { ApprovalChainEntry, ApprovalRequest } from "@/lib/db";

const U_SUBJECT = "u-subject";
const U_SUP     = "u-supervisor";
const U_POC     = "u-poc";

function makeRequest(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    productionId: "prod-1",
    subjectId: U_SUBJECT,
    subjectName: "申请人",
    type: "resource_access",
    resourceType: "cue_list",
    resourceId: "*",
    resourceSub: "*",
    permissionLevel: "view",
    grantType: "permanent",
    ttlDurationLabel: null,
    note: null,
    status: "pending_supervisor",
    escalationChain: [],
    currentStage: null,
    currentApproverIds: [],
    canFinalize: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    grantedAt: null,
    expiresAt: null,
    people: {},
    ...over,
  };
}

function entry(over: Partial<ApprovalChainEntry> = {}): ApprovalChainEntry {
  return {
    phase: "supervisor",
    stage: "supervisor",
    depth: 0,
    approverIds: [U_SUP],
    notifiedAt: "2026-08-20T10:00:00.000Z",
    ...over,
  };
}

const byKey = (nodes: ReturnType<typeof buildApprovalTimeline>, key: string) =>
  nodes.find((n) => n.key === key);

describe("骨架", () => {
  it("恒以「提交申请」开头，申请理由挂在发起节点上", () => {
    const nodes = buildApprovalTimeline(makeRequest({ note: "首演需要改 Cue" }));
    expect(nodes[0].kind).toBe("发起");
    expect(nodes[0].people).toEqual([U_SUBJECT]);
    expect(nodes[0].comment).toBe("首演需要改 Cue");
  });

  it("待审批：链末条是当前节点，之前的级按动作收尾", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_resource",
      escalationChain: [
        entry({ action: "escalated", actorId: U_SUP, escalationReason: "forwarded" }),
        entry({ stage: "dept_poc", approverIds: [U_POC] }),
      ],
    }));
    expect(nodes[1].state).toBe("complete");
    expect(nodes[1].actionLabel).toBe("已转交");
    expect(nodes[2].state).toBe("current");
    expect(nodes[2].title).toBe("共管部门负责人");
  });

  it("级名与层深走共享文案：depth=0 不加「第 N 级」，depth>0 才加", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_supervisor",
      escalationChain: [entry(), entry({ depth: 1 })],
    }));
    expect(nodes[1].title).toBe("直属上级");
    expect(nodes[2].title).toBe("直属上级 · 第 2 级");
  });

  it("存量条目没有 stage，只按旧两段式 phase 给名字", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_resource",
      escalationChain: [{ phase: "resource", approverIds: [U_POC], notifiedAt: "2026-08-20T10:00:00.000Z" }],
    }));
    expect(nodes[1].title).toBe("资源负责人");
  });
});

describe("超时自动升级", () => {
  // 回归：此前 UI 把「原因」挂在「操作人」下面渲染，而超时升级恒无 actorId，
  // 于是最该说清楚的那句话一个字都显示不出来。
  it("超时条目：没有操作人、标 bySystem、原因说明白", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_resource",
      escalationChain: [
        entry({ action: "escalated", escalationReason: "timeout", bySystem: true }),
        entry({ stage: "dept_poc", approverIds: [U_POC] }),
      ],
    }));
    const timedOut = nodes[1];
    expect(timedOut.actorId).toBeUndefined();
    expect(timedOut.bySystem).toBe(true);
    expect(timedOut.reason).toBe("无人处理，超时自动升级");
  });

  it("人工转交：有操作人，原因与超时分得开", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_resource",
      escalationChain: [
        entry({ action: "escalated", actorId: U_SUP, escalationReason: "forwarded" }),
        entry({ stage: "dept_poc", approverIds: [U_POC] }),
      ],
    }));
    expect(nodes[1].actorId).toBe(U_SUP);
    expect(nodes[1].bySystem).toBeUndefined();
    expect(nodes[1].reason).toBe("审批人向上转交");
  });
});

describe("终结语义", () => {
  it("撤回：那一级是「未处理」而不是「已完成」，终结节点带撤回人", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "cancelled",
      resolvedAt: "2026-08-21T09:00:00.000Z",
      resolvedBy: U_SUBJECT,
      escalationChain: [entry({
        action: "cancelled", actorId: U_SUBJECT, cancelReason: "by_subject",
        actedAt: "2026-08-21T09:00:00.000Z",
      })],
    }));
    expect(nodes[1].state).toBe("terminated");
    expect(nodes[1].actionLabel).toBe("未处理");
    const terminal = byKey(nodes, "terminal")!;
    expect(terminal.title).toBe("申请已撤回");
    expect(terminal.people).toEqual([U_SUBJECT]);
  });

  // 「我那条申请怎么自己没了」——被自己提的新申请顶掉是最需要解释的一种终结
  it("被新申请顶掉：终结节点说清原因，且不把申请人列成操作者", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "cancelled",
      resolvedAt: "2026-08-21T09:00:00.000Z",
      resolvedBy: U_SUBJECT,
      escalationChain: [entry({
        action: "cancelled", bySystem: true, cancelReason: "superseded",
        actedAt: "2026-08-21T09:00:00.000Z",
      })],
    }));
    const terminal = byKey(nodes, "terminal")!;
    expect(terminal.title).toBe("已被新申请取代");
    expect(terminal.people).toEqual([]);
    expect(terminal.reason).toContain("新申请");
  });

  it("拒绝：该级与终结节点都是 rejected，理由挂在该级上", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "rejected",
      resolvedAt: "2026-08-21T09:00:00.000Z",
      resolvedBy: U_SUP,
      escalationChain: [entry({
        action: "rejected", actorId: U_SUP, actedAt: "2026-08-21T09:00:00.000Z",
        comment: "本轮冻结，首演后再申请",
      })],
    }));
    expect(nodes[1].state).toBe("rejected");
    expect(nodes[1].comment).toBe("本轮冻结，首演后再申请");
    expect(byKey(nodes, "terminal")!.state).toBe("rejected");
  });

  // 存量兜底：已终结却没有动作的条目不能画成「等待中」——那读起来像还挂在这些人手上
  it("已终结但链末条没有动作 → terminated", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "cancelled",
      resolvedAt: "2026-08-21T09:00:00.000Z",
      escalationChain: [entry()],
    }));
    expect(nodes[1].state).toBe("terminated");
  });

  // 链里只有「已经到达过」的级，所以中段条目没有 action 就是异常（升级时漏补落点）。
  // 它必须画成「未处理」——画成「等待中」会让人以为申请还挂在这一级，
  // 而实际上流程早就走到下一级去了。
  it("待审批申请的中段条目缺动作 → terminated，不是「还在等」", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_resource",
      escalationChain: [
        entry(),                                          // 漏补落点的中段条目
        entry({ stage: "dept_poc", approverIds: [U_POC] }),
      ],
    }));
    expect(nodes[1].state).toBe("terminated");
    expect(nodes[2].state).toBe("current");
  });
});

describe("权限发放（审批 ≠ 办结）", () => {
  it("批准且已发放：多一个发放节点，带有效期", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "approved",
      resolvedAt: "2026-08-21T09:00:00.000Z",
      resolvedBy: U_POC,
      grantedAt: "2026-08-21T09:00:00.000Z",
      expiresAt: "2026-08-28T09:00:00.000Z",
      escalationChain: [entry({ action: "approved", actorId: U_POC })],
    }));
    const granted = byKey(nodes, "granted")!;
    expect(granted.kind).toBe("发放");
    expect(granted.expiresAt).toBe("2026-08-28T09:00:00.000Z");
    // 顺序：发放在终结之前
    expect(nodes.indexOf(granted)).toBeLessThan(nodes.findIndex((n) => n.key === "terminal"));
  });

  it("永久授权：expiresAt 为 null（渲染侧显示「长期有效」）", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "approved", grantedAt: "2026-08-21T09:00:00.000Z", expiresAt: null,
      escalationChain: [entry({ action: "approved", actorId: U_POC })],
    }));
    expect(byKey(nodes, "granted")!.expiresAt).toBeNull();
  });

  it("未批准的申请没有发放节点", () => {
    const nodes = buildApprovalTimeline(makeRequest({ status: "pending_supervisor", escalationChain: [entry()] }));
    expect(byKey(nodes, "granted")).toBeUndefined();
  });
});

describe("或签提示", () => {
  it("同级多人 → anyOneOf，单人不标", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_resource",
      escalationChain: [
        entry({ approverIds: [U_SUP] }),
        entry({ stage: "dept_poc", approverIds: [U_POC, "u-poc-2"] }),
      ],
    }));
    expect(nodes[1].anyOneOf).toBe(false);
    expect(nodes[2].anyOneOf).toBe(true);
  });
});

// client component 直接 import 这两个模块。哪天有人把 `import type { X } from "./db"`
// 写成 `import { X }`，或图省事引一下 getPool，pg 就会被打进浏览器包——
// 编译不会报错，跑起来才炸。静态扫一遍，把「客户端安全」从口头约定变成会红的测试。
describe("客户端安全：不得把数据库拖进浏览器包", () => {
  const CLIENT_SAFE = ["lib/approval-timeline.ts", "lib/approval-stages.ts"];

  it.each(CLIENT_SAFE)("%s 对 ./db 只有 type-only 引用，且不碰 pg", async (rel) => {
    const src = await readFile(path.join(process.cwd(), rel), "utf8");
    const imports = [...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)];

    for (const [, typeOnly, spec] of imports) {
      if (/(^|\/)pg$/.test(spec) || spec.endsWith("/pg")) {
        throw new Error(`${rel} 直接 import 了 ${spec}`);
      }
      if (spec.endsWith("/db") || spec === "./db") {
        expect(typeOnly, `${rel} 对 ${spec} 必须是 import type`).toBeTruthy();
      }
    }
    // 值引用形式的 getPool 同样会把驱动带进来
    expect(src).not.toMatch(/\bgetPool\b/);
  });
});

describe("存量降级", () => {
  it("无链但在审批中：用 current_* 合成一条，至少说得出卡在谁那儿", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "pending_resource",
      escalationChain: [],
      currentStage: "dept_poc",
      currentApproverIds: [U_POC],
    }));
    expect(nodes[1].title).toBe("共管部门负责人");
    expect(nodes[1].people).toEqual([U_POC]);
    expect(nodes[1].state).toBe("current");
  });

  // 回归：此前无链且已终结时会同时生成「历史审批记录」和「结束」两个节点，
  // 同一个人、同一个时间连着出现两遍
  it("无链且已终结：只出一个终结节点，不重复", () => {
    const nodes = buildApprovalTimeline(makeRequest({
      status: "approved",
      escalationChain: [],
      resolvedAt: "2026-08-21T09:00:00.000Z",
      resolvedBy: U_POC,
    }));
    expect(nodes.filter((n) => n.people.includes(U_POC))).toHaveLength(1);
    expect(nodes.map((n) => n.kind)).toEqual(["发起", "结束"]);
  });
});
