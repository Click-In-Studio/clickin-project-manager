import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const deploy = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");

function section(source: string, start: string, end?: string): string {
  const startAt = source.indexOf(start);
  const endAt = end ? source.indexOf(end, startAt + start.length) : source.length;
  expect(startAt, `缺少 ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `缺少 ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("发布门禁 workflow", () => {
  it("PR CI 构建三个生产运行入口", () => {
    const buildJob = section(ci, "  production-build:", "  unit-test:");

    expect(buildJob).toContain("run: npm run build\n");
    expect(buildJob).toContain("run: npm run build:runner\n");
    expect(buildJob).toContain("run: npm run build:worker\n");
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
    expect(migration).toContain('pm2 stop "$APP" || STOP_FAILED=1');
    expect(migration).toContain('exit "$STOP_FAILED"');
    expect(migration).toContain('pm2 stop "$APP"');
    expect(migration.indexOf('pm2 stop "$APP"')).toBeLessThan(migration.indexOf('ssh prod "$DBMATE up"'));
    expect(migration).toContain("MIGRATION FAILED — 服务保持停止");
    expect(migration).not.toContain("该支已整体回滚");

    expect(activation).toContain("pm2 startOrReload");
    expect(activation).toContain("http://127.0.0.1:3001/login");
    expect(activation).toContain("http://127.0.0.1:3102/health");
    expect(activation).toContain("http://127.0.0.1:3103/health");
    expect(activation).toContain('for APP in production-manager agent-runner heavy-worker; do pm2 stop "$APP" || true; done');
  });
});
