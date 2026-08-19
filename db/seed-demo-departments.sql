-- 为本地《雾港来信》演示项目补齐制作部门；幂等执行，不删除既有数据。
INSERT INTO production_dept (id, production_id, name, display_order) VALUES
  ('10000000-0000-4000-8000-000000000006', 'demo-misty-harbor', '导演组', 6),
  ('10000000-0000-4000-8000-000000000007', 'demo-misty-harbor', '演员', 7),
  ('10000000-0000-4000-8000-000000000008', 'demo-misty-harbor', '舞美', 8),
  ('10000000-0000-4000-8000-000000000009', 'demo-misty-harbor', '道具', 9),
  ('10000000-0000-4000-8000-000000000010', 'demo-misty-harbor', '化妆', 10),
  ('10000000-0000-4000-8000-000000000011', 'demo-misty-harbor', '发型', 11),
  ('10000000-0000-4000-8000-000000000012', 'demo-misty-harbor', '服装', 12),
  ('10000000-0000-4000-8000-000000000013', 'demo-misty-harbor', '视频', 13),
  ('10000000-0000-4000-8000-000000000014', 'demo-misty-harbor', '舞台机械', 14),
  ('10000000-0000-4000-8000-000000000015', 'demo-misty-harbor', '宣传', 15),
  ('10000000-0000-4000-8000-000000000016', 'demo-misty-harbor', '票务与前台', 16),
  ('10000000-0000-4000-8000-000000000017', 'demo-misty-harbor', '制作管理', 17)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    display_order = EXCLUDED.display_order;
