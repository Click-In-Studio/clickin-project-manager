-- #85 元数据基建：asset_file 加 metadata 列（信封 JSONB）。
--
-- 挂 asset_file 不挂 asset：元数据是字节的属性；asset_file 行追加式不可变
-- （新上传=新行），所以元数据以 (asset_file_id, parserVersion) 为键永不失效，
-- 算一次存一辈子，无缓存一致性问题。asset 层展示取 latest file（latest-wins）。
--
-- 列里存的永远是信封（MetadataEnvelope，见 lib/asset/metadata.ts）不是裸数据：
-- status/brokerVersion/parserKey/parserVersion/detectedType/data/sidecarKey/error。
-- data 的 shape 归各分析器私有，基建不定义字段词表；跨类型查询要 promote 到列
-- 时另开 issue。failed/unsupported 也落盘（损坏文件不能每次打开都重拉重失败），
-- 重试条件只有版本号比当前代码低。
--
-- 以 postgres 用户在 script_editor 库执行：
--   psql -U postgres -d script_editor -f db/add-asset-file-metadata.sql

ALTER TABLE asset_file ADD COLUMN IF NOT EXISTS metadata JSONB;
