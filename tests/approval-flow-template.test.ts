import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPROVAL_FLOW_TEMPLATES,
  createApprovalTemplateNode,
  moveApprovalTemplateNode,
} from "@/lib/approval-flow-template";

describe("approval flow templates", () => {
  it("标准模板覆盖审批、抄送与处理节点", () => {
    const standard = DEFAULT_APPROVAL_FLOW_TEMPLATES[0];
    expect(standard.nodes.map((node) => node.type)).toEqual([
      "approval",
      "approval",
      "cc",
      "processing",
    ]);
  });

  it("新增节点带有可编辑的安全默认值", () => {
    expect(createApprovalTemplateNode("approval", 5)).toMatchObject({
      id: "approval-5",
      decisionMode: "any",
      timeoutHours: 24,
      optional: false,
    });
  });

  it("节点可以移动，越界操作保持原序", () => {
    const nodes = DEFAULT_APPROVAL_FLOW_TEMPLATES[0].nodes;
    expect(moveApprovalTemplateNode(nodes, 1, -1)[0].id).toBe(nodes[1].id);
    expect(moveApprovalTemplateNode(nodes, 0, -1)).toBe(nodes);
  });
});
