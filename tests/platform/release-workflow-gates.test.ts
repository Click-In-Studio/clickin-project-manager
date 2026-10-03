import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const prAutomation = fs.readFileSync(path.join(root, ".github/workflows/pr-automation.yml"), "utf8");
const deploy = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const ecosystem = fs.readFileSync(path.join(root, "deploy/ecosystem.config.js"), "utf8");

function section(source: string, start: string, end?: string): string {
  const startAt = source.indexOf(start);
  const endAt = end ? source.indexOf(end, startAt + start.length) : source.length;
  expect(startAt, `缺少 ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `缺少 ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("发布门禁 workflow", () => {
  it("依赖 PR 改回 main 后重跑正式门禁并重算 diff 提醒", () => {
    const ciTrigger = section(ci, "on:\n", "jobs:");
    const automationTrigger = section(prAutomation, "on:\n", "jobs:");

    expect(ciTrigger).toContain("branches: [main]");
    expect(ciTrigger).toContain("types: [opened, synchronize, reopened, edited]");
    expect(automationTrigger).toContain(
      "types: [opened, synchronize, reopened, edited, labeled, unlabeled]",
    );
  });

  it("PR CI 构建三个生产运行入口", () => {
    const buildJob = section(ci, "  production-build:", "  unit-test:");

    expect(buildJob).toContain("run: npm run build\n");
    expect(buildJob).toContain("run: npm run build:runner\n");
    expect(buildJob).toContain("run: npm run build:worker\n");
  });

  it("migration 护栏只检查 PR 从分叉点起引入的改动", () => {
    const unitTestJob = section(ci, "  unit-test:", "  print-consistency:");
    const migrationGuard = section(
      unitTestJob,
      "      - name: Forbid touching merged migrations",
      "      - name: Apply base-branch migrations",
    );

    expect(migrationGuard).toContain(
      "git diff origin/$GITHUB_BASE_REF...HEAD --name-only --diff-filter=MDR",
    );
    expect(migrationGuard).not.toContain(
      "git diff origin/$GITHUB_BASE_REF HEAD --name-only --diff-filter=MDR",
    );
    expect(unitTestJob).toContain(
      "uses: actions/checkout@v4.2.2\n        with:\n          fetch-depth: 0",
    );
    expect(unitTestJob).toContain('git fetch origin "$GITHUB_BASE_REF"');
  });

  it("tag 在部署前完成全量验证", () => {
    const validationJob = section(deploy, "  tag-validation:", "  deploy:");
    const deployJob = section(deploy, "  deploy:");

    expect(validationJob).toContain("if: github.ref_type == 'tag'");
    expect(validationJob).toContain("run: npx tsc --noEmit");
    expect(validationJob).toContain("run: npm run lint");
    expect(validationJob).toContain("run: npm run db -- up");
    expect(validationJob).toContain("run: npm run db:check");
    expect(validationJob).toContain("run: npm test");
    expect(validationJob).toContain("npm run test:markers\n");
    expect(validationJob).toContain("npm run test:markers:db");
    expect(validationJob).toContain("npm run test:selection");
    expect(validationJob).not.toContain("SERVER_HOST");
    expect(validationJob).not.toContain("ssh ");

    expect(deployJob).toContain("needs: tag-validation");
    expect(deployJob).toContain("needs.tag-validation.result == 'success'");
    expect(deployJob.indexOf("Build (standalone)")).toBeLessThan(
      deployJob.indexOf("Setup SSH"),
    );
  });

  it("pending migration 先停数据库客户端，激活后验证三个入口", () => {
    const deployJob = section(deploy, "  deploy:");
    const migration = section(deployJob, "      - name: Run DB migrations", "      - name: Activate release");
    const activation = section(deployJob, "      - name: Activate release", "      # ── 10.");

    expect(migration).toContain('if [ "$PENDING" -gt 0 ]');
    expect(migration).toContain("STOP_FAILED=0");
    expect(migration).toContain('pm2 delete "$APP" || STOP_FAILED=1');
    expect(migration).toContain('exit "$STOP_FAILED"');
    expect(migration).toContain('pm2 delete "$APP"');
    expect(migration.indexOf('pm2 delete "$APP"')).toBeLessThan(migration.indexOf('ssh prod "$DBMATE up"'));
    expect(migration.indexOf("unlink /var/www/production-manager/current")).toBeLessThan(
      migration.indexOf('ssh prod "$DBMATE up"'),
    );
    expect(migration).toContain("MIGRATION FAILED — 服务保持停止");
    expect(migration).not.toContain("该支已整体回滚");

    expect(activation).toContain("pm2 startOrReload");
    expect(activation).toContain("SCHEMA_CHANGED");
    expect(activation).toContain('NEW_ECOSYSTEM="${{ env.RELEASE_DIR }}/ecosystem.config.js"');
    expect(activation).not.toContain("scp deploy/ecosystem.config.js");
    expect(activation).toContain('ln -snf "$PREVIOUS_RELEASE"');
    expect(activation).toContain("unlink /var/www/production-manager/current");
    const healthPorts = [...ecosystem.matchAll(/^\s+(?:PORT|AGENT_RUNNER_PORT|HEAVY_WORKER_PORT):\s*(\d+),$/gm)]
      .map((match) => match[1]);
    expect(healthPorts).toHaveLength(3);
    for (const port of healthPorts) expect(activation).toContain(`http://127.0.0.1:${port}/health`);
    expect(activation).toContain('header = "Authorization: Bearer %s"');
    expect(activation).toContain('curl -fsS --max-time 3 --config -');
    expect(activation).not.toContain('-H "Authorization: Bearer $HEALTH_SECRET"');
    expect(activation).toContain("--max-time 3");
    expect(activation).toContain('pm2 delete "$APP" || STOP_FAILED=1');
    expect(activation).not.toContain('pm2 stop "$APP" || STOP_FAILED=1');
    expect(activation).toContain("::error::一个或多个数据库客户端进程停止或移除失败");
    expect(activation.indexOf('cp "$NEW_ECOSYSTEM"')).toBeGreaterThan(activation.indexOf("http://127.0.0.1:3103/health"));
  });
});
