-- 结构指纹：一库一行一对象，排好序，跨 PG 版本稳定。
--
-- 三处用同一份 SQL：
--   · scripts/db-fingerprint.ts / db-check.ts（本地与 CI，经 pg 驱动执行）
--   · CD 发布后在服务器 `psql -qAt -f` 直接跑，与提交的 db/schema-fingerprint.txt 逐行比
-- 所以这里只能是**一条**纯 SQL，不能有 psql 元命令、不能带参数。
--
-- 刻意排除的东西（否则指纹会随环境而非 schema 变化）：
--   · schema_migrations（dbmate 自己的表，psql -f schema.sql 建的库没有它）
--   · contype = 'n'（PG 18 起 NOT NULL 也进 pg_constraint；列的 is_nullable 已覆盖）
--   · 扩展自带的函数（pgvector 各版本函数集不同；扩展名本身仍计入）
--   · 名字以 test- 开头的表（测试夹具）
--   · GRANT / owner（属环境引导，见 db/bootstrap-roles.sql，不属 schema）
-- 排序用 COLLATE "C"：服务器 locale 与 CI 容器不同，按字节序才逐行可比。
SELECT line FROM (
  SELECT 'COL|' || table_name || '|' || column_name || '|' || data_type || '|' || udt_name
         || '|' || is_nullable || '|' || coalesce(column_default, '') AS line
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name NOT LIKE 'test-%'
    AND table_name <> 'schema_migrations'
  UNION ALL
  SELECT 'CON|' || c.conrelid::regclass::text || '|' || c.conname || '|' || pg_get_constraintdef(c.oid)
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.connamespace = 'public'::regnamespace
    AND c.contype <> 'n'
    AND r.relname NOT LIKE 'test-%'
    AND r.relname <> 'schema_migrations'
  UNION ALL
  SELECT 'IDX|' || tablename || '|' || indexname || '|' || indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename NOT LIKE 'test-%'
    AND tablename <> 'schema_migrations'
  UNION ALL
  SELECT 'ENUM|' || t.typname || '|' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typnamespace = 'public'::regnamespace
  GROUP BY t.typname
  UNION ALL
  SELECT 'FUNC|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
         || md5(pg_get_functiondef(p.oid))
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'TRG|' || t.tgrelid::regclass::text || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid)
  FROM pg_trigger t
  JOIN pg_class r ON r.oid = t.tgrelid
  WHERE NOT t.tgisinternal
    AND r.relnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'EXT|' || extname FROM pg_extension WHERE extname <> 'plpgsql'
  UNION ALL
  SELECT 'SEQ|' || sequencename FROM pg_sequences WHERE schemaname = 'public'
) f
ORDER BY line COLLATE "C";
