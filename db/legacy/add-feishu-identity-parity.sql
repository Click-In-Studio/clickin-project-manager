-- 飞书身份平权：飞书与邮箱是平权的登录通道，两者都登记进 user_platform_identity。
--
-- 背景：飞书通道的建号历来只写 feishu_user 专用表，不写身份表。线上现有的 feishu
-- identity 行是 PR #234 一次性回填的产物，而写入点此后仍未补写——只要有新飞书用户
-- 进来，缺口就会重新出现，且随用户增长持续扩大。本批已在 upsertFeishuUser
-- （收口后飞书通道唯一的建号入口）补齐写入，这里把历史缺口一次补平。
--
-- is_login_method = true：飞书本就是登录方式。
-- is_primary = false：primary 语义目前只对 email 有约束（见 upi_primary_email_uniq）。
--
-- 幂等：WHERE NOT EXISTS + ON CONFLICT DO NOTHING 双保险，在已无缺口的库上是 no-op。
-- 注意本脚本只补 feishu 身份，不碰 email —— 邮箱绑定等同于开通该邮箱的登录能力
-- （注册门的 existing 判定不筛 is_login_method），须单独决策，不在本批范围内。

INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
SELECT f.user_id, 'feishu', f.open_id, true, false
FROM feishu_user f
WHERE NOT EXISTS (
  SELECT 1 FROM user_platform_identity i
  WHERE i.platform_id = 'feishu' AND i.platform_user_id = f.open_id
)
ON CONFLICT (platform_id, platform_user_id) DO NOTHING;
