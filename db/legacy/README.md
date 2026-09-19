# db/legacy/ — dbmate 接管前的历史迁移（只读）

2026-09-19（#561）起，schema 变更一律走 `db/migrations/`（dbmate）。这里的 144 支
`add-*.sql` / `migrate-*.sql` 是接管前六个月的全部历史，**全部已在线上执行完毕**，
线上状态已对账进 baseline（`db/migrations/20260919000000_baseline.sql`）。

保留原因：

- `tests/migrations/` 里的历史迁移测试还读它们（`readFileSync("db/legacy/...")`），
  那些测试的 invariance 层在没有快照时自动跳过，只剩 schema / integrity 层当回归护栏；
- 文件头注释记录了当时的设计决策，`lib/` 里不少注释引用它们的文件名。

**不要往这里加文件，也不要再手动执行这里的任何文件。**

- `reverse-migrate-internal-user-id.sql`：当年为导出迁移前 CI seed 写的逆向脚本，只在本地用过。
- `reconcile-prod-2026-09.sql`：接管时线上对账脚本（一次性），执行记录见 #561。
