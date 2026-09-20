-- Phase 4: 将 cue_list_permission + cue_list_role 迁移至 resource_grant(grant_source='migrated')
-- 执行后删除两张旧表（权限管理完全切换至 resource_grant）。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cue_list_permission'
  ) THEN

    -- 步骤 1：cue_list_permission(can_edit=true) → resource_grant(edit, migrated)
    INSERT INTO resource_grant (
      production_id, user_id, resource_type, resource_id, resource_sub,
      permission_level, grant_source, confirmed_by
    )
    SELECT
      cl.production_id,
      clp.user_id,
      'cue_list',
      clp.cue_list_id,
      '*',
      'edit',
      'migrated',
      NULL::uuid
    FROM cue_list_permission clp
    JOIN cue_list cl ON cl.id = clp.cue_list_id
    WHERE clp.can_edit = true
    ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
      WHERE is_revoked = false
    DO NOTHING;

    -- 步骤 2：cue_list 创建者 → resource_grant(manage, migrated)
    INSERT INTO resource_grant (
      production_id, user_id, resource_type, resource_id, resource_sub,
      permission_level, grant_source, confirmed_by
    )
    SELECT DISTINCT
      cl.production_id,
      cl.created_by,
      'cue_list',
      cl.id,
      '*',
      'manage',
      'migrated',
      NULL::uuid
    FROM cue_list cl
    ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
      WHERE is_revoked = false
    DO NOTHING;

    -- 步骤 3：cue_list_role → 展开为用户 → resource_grant(edit, migrated)
    INSERT INTO resource_grant (
      production_id, user_id, resource_type, resource_id, resource_sub,
      permission_level, grant_source, confirmed_by
    )
    SELECT DISTINCT
      cl.production_id,
      pm.user_id,
      'cue_list',
      clr.cue_list_id,
      '*',
      'edit',
      'migrated',
      NULL::uuid
    FROM cue_list_role clr
    JOIN production_role pr ON pr.id = clr.role_id
    JOIN production_member pm
      ON pm.production_id = pr.production_id
      AND pr.name = ANY(pm.roles)
    JOIN cue_list cl ON cl.id = clr.cue_list_id
    ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
      WHERE is_revoked = false
    DO NOTHING;

    DROP TABLE cue_list_role;
    DROP TABLE cue_list_permission;

  END IF;
END $$;
