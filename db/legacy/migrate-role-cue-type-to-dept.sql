-- Phase 4: 将 production_role_cue_type 数据迁移至 production_dept.allowed_cue_types
-- 策略：自动映射——对于每个"拥有该 role 成员的部门"，将对应 cue_type 追加到 allowed_cue_types 数组。
-- 执行后删除 production_role_cue_type 表（cue 类型授权改由部门 allowed_cue_types 管理）。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'production_role_cue_type'
  ) THEN
    WITH dept_cue_types AS (
      SELECT DISTINCT
        pdm.dept_id,
        prct.cue_type
      FROM production_dept_member pdm
      JOIN production_member pm
        ON pm.production_id = pdm.production_id
        AND pm.user_id = pdm.user_id
      JOIN production_role pr
        ON pr.production_id = pdm.production_id
        AND pr.name = ANY(pm.roles)
      JOIN production_role_cue_type prct ON prct.role_id = pr.id
    )
    UPDATE production_dept pd
    SET allowed_cue_types = (
      SELECT ARRAY(
        SELECT DISTINCT val
        FROM (
          SELECT unnest(pd.allowed_cue_types) AS val
          UNION ALL
          SELECT dct.cue_type
          FROM dept_cue_types dct
          WHERE dct.dept_id = pd.id
        ) combined
        ORDER BY val
      )
    )
    WHERE pd.id IN (SELECT dept_id FROM dept_cue_types);

    DROP TABLE production_role_cue_type;
  END IF;
END $$;
