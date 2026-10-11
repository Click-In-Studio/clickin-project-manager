import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../../.github/workflows/pr-automation.yml"), "utf8",
);
const job = workflow.slice(workflow.indexOf("  changelog-check:"), workflow.indexOf("  ai-review:"));
const script = job.slice(job.indexOf("          script: |\n") + "          script: |\n".length)
  .split("\n").filter(line => line.startsWith("            "))
  .map(line => line.slice(12)).join("\n");

function fixture(hasEntry = false) {
  const comment = { id: 942, user: { type: "Bot" }, body: "<!-- changelog-reminder -->" };
  const github = {
    rest: {
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: [{
          filename: hasEntry ? "content/changelog/unreleased/942-fix.md" : "lib/example.ts",
          status: "added",
        }] }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [comment] }),
        deleteComment: vi.fn().mockResolvedValue(undefined),
        createComment: vi.fn(),
      },
    },
  };
  const context = {
    repo: { owner: "test-owner", repo: "test-repo" },
    payload: { pull_request: { number: 942, labels: hasEntry ? [] : [{ name: "workflow" }] } },
  };
  return {
    comment,
    issues: github.rest.issues,
    run: () => runInNewContext(`(async () => {\n${script}\n})()`, { github, context }) as Promise<void>,
  };
}

describe("更新日志提醒删除", () => {
  it.each([false, true])("两个任务读到同一条提醒后删除均成功（已有条目：%s）", async hasEntry => {
    const { comment, issues, run } = fixture(hasEntry);
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    issues.listComments.mockImplementation(async () => {
      // 两个任务都拿到删除前的快照，才允许任一任务继续。
      const snapshot = { data: [comment] };
      if (++reads === 2) release();
      await bothRead;
      return snapshot;
    });
    let deleted = false;
    issues.deleteComment.mockImplementation(async () => {
      if (deleted) throw Object.assign(new Error("Not Found"), { status: 404 });
      deleted = true;
    });

    await expect(Promise.all([run(), run()])).resolves.toEqual([undefined, undefined]);
    expect(issues.deleteComment).toHaveBeenCalledTimes(2);
    expect(issues.deleteComment).toHaveBeenNthCalledWith(1, {
      owner: "test-owner", repo: "test-repo", comment_id: comment.id,
    });
    expect(issues.deleteComment).toHaveBeenNthCalledWith(2, {
      owner: "test-owner", repo: "test-repo", comment_id: comment.id,
    });
    expect(issues.createComment).not.toHaveBeenCalled();
  });

  it("删除成功与提醒已经不存在时均通过", async () => {
    const { issues, run } = fixture();
    await expect(run()).resolves.toBeUndefined();
    issues.listComments.mockResolvedValue({ data: [] });
    await expect(run()).resolves.toBeUndefined();
    expect(issues.deleteComment).toHaveBeenCalledTimes(1);
    expect(issues.createComment).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, undefined])("其他 API 错误仍失败（status：%s）", async status => {
    const { issues, run } = fixture();
    const error = Object.assign(new Error("API failure"), { status });
    issues.deleteComment.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(issues.createComment).not.toHaveBeenCalled();
  });
});
