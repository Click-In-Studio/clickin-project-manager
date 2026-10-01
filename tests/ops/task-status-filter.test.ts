import { describe, expect, it } from "vitest";
import { taskMatchesStatusFilter } from "@/lib/ops/task-types";

describe("任务状态筛选", () => {
  const mine = new Set(["mine"]);

  it("待我确认 = awaiting 且我是责任主体 POC", () => {
    expect(taskMatchesStatusFilter({ id: "mine", status: "awaiting" }, "awaiting", mine)).toBe(true);
    expect(taskMatchesStatusFilter({ id: "other", status: "awaiting" }, "awaiting", mine)).toBe(false);
    expect(taskMatchesStatusFilter({ id: "mine", status: "pending" }, "awaiting", mine)).toBe(false);
  });

  it("进行中任务仍保留有权查看的其他待确认任务", () => {
    expect(taskMatchesStatusFilter({ id: "other", status: "awaiting" }, "active", mine)).toBe(true);
  });

  it("其他状态筛选不受 POC 关系影响", () => {
    expect(taskMatchesStatusFilter({ id: "other", status: "pending" }, "pending", mine)).toBe(true);
    expect(taskMatchesStatusFilter({ id: "mine", status: "in_progress" }, "pending", mine)).toBe(false);
  });
});
