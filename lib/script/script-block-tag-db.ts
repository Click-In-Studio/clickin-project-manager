import { getPool } from "../pg";

// 块标签（#486 从 lib/db.ts 搬出）：tag_group / tag_option 的 CRUD 与 block_tag 的读写。
// applyPatchToDB 事务内的 validateTagsInTx / writeBlockTagsInTx 留在 patch 侧，不在这里。

export type TagOption = {
  id: string;
  groupId: string;
  label: string;
  color: string;
  sortOrder: number;
};

export type TagGroup = {
  id: string;
  productionId: string;
  name: string;
  type: 'exclusive' | 'range';
  rangeMin: number | null;
  rangeMax: number | null;
  rangeStep: number | null;
  rangeDefault: number | null;
  defaultOptionId: string | null;
  lyricSplitAfterOptionId: string | null;
  sortOrder: number;
  options: TagOption[];
};

export type BlockTagValue = {
  blockId: string;
  groupId: string;
  optionId: string | null;
  value: number | null;
};

type TagGroupRow = {
  id: string;
  production_id: string;
  name: string;
  type: 'exclusive' | 'range';
  range_min: string | null;
  range_max: string | null;
  range_step: string | null;
  range_default: string | null;
  default_option_id: string | null;
  lyric_split_after_option_id: string | null;
  sort_order: number;
  option_id: string | null;
  option_label: string | null;
  option_color: string | null;
  option_sort_order: number | null;
};

type TagOptionRow = {
  id: string;
  group_id: string;
  label: string;
  color: string;
  sort_order: number;
};

type BlockTagRow = {
  block_id: string;
  group_id: string;
  option_id: string | null;
  value: string | null;
};

function rowToTagOption(r: TagOptionRow): TagOption {
  return {
    id: r.id,
    groupId: r.group_id,
    label: r.label,
    color: r.color,
    sortOrder: r.sort_order,
  };
}

export async function listTagGroups(productionId: string): Promise<TagGroup[]> {
  const res = await getPool().query<TagGroupRow>(
    `SELECT tg.id, tg.production_id, tg.name, tg.type,
            tg.range_min, tg.range_max, tg.range_step, tg.range_default,
            tg.default_option_id, tg.lyric_split_after_option_id, tg.sort_order,
            topt.id AS option_id, topt.label AS option_label,
            topt.color AS option_color, topt.sort_order AS option_sort_order
     FROM tag_group tg
     LEFT JOIN tag_option topt ON topt.group_id = tg.id
     WHERE tg.production_id = $1
     ORDER BY tg.sort_order, topt.sort_order`,
    [productionId]
  );
  const groupMap = new Map<string, TagGroup>();
  for (const r of res.rows) {
    if (!groupMap.has(r.id)) {
      groupMap.set(r.id, {
        id: r.id,
        productionId: r.production_id,
        name: r.name,
        type: r.type,
        rangeMin: r.range_min != null ? Number(r.range_min) : null,
        rangeMax: r.range_max != null ? Number(r.range_max) : null,
        rangeStep: r.range_step != null ? Number(r.range_step) : null,
        rangeDefault: r.range_default != null ? Number(r.range_default) : null,
        defaultOptionId: r.default_option_id,
        lyricSplitAfterOptionId: r.lyric_split_after_option_id,
        sortOrder: r.sort_order,
        options: [],
      });
    }
    if (r.option_id != null) {
      groupMap.get(r.id)!.options.push({
        id: r.option_id,
        groupId: r.id,
        label: r.option_label!,
        color: r.option_color!,
        sortOrder: r.option_sort_order!,
      });
    }
  }
  return Array.from(groupMap.values());
}

export async function createTagGroup(
  productionId: string,
  params: {
    name: string;
    type: 'exclusive' | 'range';
    rangeMin?: number;
    rangeMax?: number;
    rangeStep?: number;
    rangeDefault?: number;
  }
): Promise<TagGroup> {
  const id = `tg${Date.now().toString(36)}`;
  const res = await getPool().query<{
    id: string; production_id: string; name: string; type: string;
    range_min: string | null; range_max: string | null;
    range_step: string | null; range_default: string | null;
    default_option_id: string | null; lyric_split_after_option_id: string | null; sort_order: number;
  }>(
    `INSERT INTO tag_group (id, production_id, name, type, range_min, range_max, range_step, range_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, production_id, name, type, range_min, range_max, range_step, range_default,
               default_option_id, lyric_split_after_option_id, sort_order`,
    [
      id, productionId, params.name, params.type,
      params.rangeMin ?? null, params.rangeMax ?? null,
      params.rangeStep ?? null, params.rangeDefault ?? null,
    ]
  );
  const r = res.rows[0];
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    type: r.type as 'exclusive' | 'range',
    rangeMin: r.range_min != null ? Number(r.range_min) : null,
    rangeMax: r.range_max != null ? Number(r.range_max) : null,
    rangeStep: r.range_step != null ? Number(r.range_step) : null,
    rangeDefault: r.range_default != null ? Number(r.range_default) : null,
    defaultOptionId: r.default_option_id,
    lyricSplitAfterOptionId: r.lyric_split_after_option_id,
    sortOrder: r.sort_order,
    options: [],
  };
}

export async function updateTagGroup(
  id: string,
  params: {
    name?: string;
    rangeMin?: number | null;
    rangeMax?: number | null;
    rangeStep?: number | null;
    rangeDefault?: number | null;
    defaultOptionId?: string | null;
    lyricSplitAfterOptionId?: string | null;
    sortOrder?: number;
  }
): Promise<TagGroup | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.name !== undefined)                    { sets.push(`name = $${idx++}`);                          values.push(params.name); }
  if (params.rangeMin !== undefined)                { sets.push(`range_min = $${idx++}`);                     values.push(params.rangeMin); }
  if (params.rangeMax !== undefined)                { sets.push(`range_max = $${idx++}`);                     values.push(params.rangeMax); }
  if (params.rangeStep !== undefined)               { sets.push(`range_step = $${idx++}`);                    values.push(params.rangeStep); }
  if (params.rangeDefault !== undefined)            { sets.push(`range_default = $${idx++}`);                 values.push(params.rangeDefault); }
  if (params.defaultOptionId !== undefined)         { sets.push(`default_option_id = $${idx++}`);             values.push(params.defaultOptionId); }
  if (params.lyricSplitAfterOptionId !== undefined) { sets.push(`lyric_split_after_option_id = $${idx++}`);   values.push(params.lyricSplitAfterOptionId); }
  if (params.sortOrder !== undefined)               { sets.push(`sort_order = $${idx++}`);                    values.push(params.sortOrder); }
  if (sets.length === 0) return null;
  values.push(id);
  const res = await getPool().query<{
    id: string; production_id: string; name: string; type: string;
    range_min: string | null; range_max: string | null;
    range_step: string | null; range_default: string | null;
    default_option_id: string | null; lyric_split_after_option_id: string | null; sort_order: number;
  }>(
    `UPDATE tag_group SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, production_id, name, type, range_min, range_max, range_step, range_default,
               default_option_id, lyric_split_after_option_id, sort_order`,
    values
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  const optRes = await getPool().query<TagOptionRow>(
    'SELECT id, group_id, label, color, sort_order FROM tag_option WHERE group_id = $1 ORDER BY sort_order',
    [id]
  );
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    type: r.type as 'exclusive' | 'range',
    rangeMin: r.range_min != null ? Number(r.range_min) : null,
    rangeMax: r.range_max != null ? Number(r.range_max) : null,
    rangeStep: r.range_step != null ? Number(r.range_step) : null,
    rangeDefault: r.range_default != null ? Number(r.range_default) : null,
    defaultOptionId: r.default_option_id,
    lyricSplitAfterOptionId: r.lyric_split_after_option_id,
    sortOrder: r.sort_order,
    options: optRes.rows.map(rowToTagOption),
  };
}

export async function deleteTagGroup(id: string): Promise<void> {
  await getPool().query('DELETE FROM tag_group WHERE id = $1', [id]);
}

export async function createTagOption(
  groupId: string,
  label: string,
  color: string,
  sortOrder: number
): Promise<TagOption> {
  const id = `to${Date.now().toString(36)}`;
  const res = await getPool().query<TagOptionRow>(
    `INSERT INTO tag_option (id, group_id, label, color, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, group_id, label, color, sort_order`,
    [id, groupId, label, color, sortOrder]
  );
  return rowToTagOption(res.rows[0]);
}

export async function updateTagOption(
  id: string,
  params: { label?: string; color?: string; sortOrder?: number }
): Promise<TagOption | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.label !== undefined)     { sets.push(`label = $${idx++}`);      values.push(params.label); }
  if (params.color !== undefined)     { sets.push(`color = $${idx++}`);      values.push(params.color); }
  if (params.sortOrder !== undefined) { sets.push(`sort_order = $${idx++}`); values.push(params.sortOrder); }
  if (sets.length === 0) return null;
  values.push(id);
  const res = await getPool().query<TagOptionRow>(
    `UPDATE tag_option SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, group_id, label, color, sort_order`,
    values
  );
  return res.rows.length ? rowToTagOption(res.rows[0]) : null;
}

export async function deleteTagOption(id: string): Promise<void> {
  await getPool().query('DELETE FROM tag_option WHERE id = $1', [id]);
}

export async function getBlockTagsForProduction(productionId: string): Promise<BlockTagValue[]> {
  const res = await getPool().query<BlockTagRow>(
    `SELECT bt.block_id, bt.group_id, bt.option_id, bt.value
     FROM block_tag bt
     JOIN tag_group tg ON tg.id = bt.group_id
     WHERE tg.production_id = $1`,
    [productionId]
  );
  return res.rows.map((r) => ({
    blockId: r.block_id,
    groupId: r.group_id,
    optionId: r.option_id,
    value: r.value != null ? Number(r.value) : null,
  }));
}

export async function upsertBlockTag(
  blockId: string,
  groupId: string,
  optionId: string | null,
  value: number | null
): Promise<void> {
  await getPool().query(
    `INSERT INTO block_tag (block_id, group_id, option_id, value, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (block_id, group_id) DO UPDATE
       SET option_id  = EXCLUDED.option_id,
           value      = EXCLUDED.value,
           updated_at = now()`,
    [blockId, groupId, optionId, value]
  );
}

export async function deleteBlockTag(blockId: string, groupId: string): Promise<void> {
  await getPool().query(
    'DELETE FROM block_tag WHERE block_id = $1 AND group_id = $2',
    [blockId, groupId]
  );
}
