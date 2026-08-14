-- 项目水印开关：开启后 production 全部页面渲染 [用户名 邮箱] 平铺水印
-- （pointer-events: none 不影响交互；配置权限=production/*/config@edit）
ALTER TABLE production ADD COLUMN IF NOT EXISTS watermark_enabled BOOLEAN NOT NULL DEFAULT false;
