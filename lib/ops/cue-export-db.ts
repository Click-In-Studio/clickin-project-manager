import { listTextBlockIdsByVersion, loadVersionBlocksByIds } from "../script/script-block-read-db";
import { loadScriptCharacterNames } from "../script/script-local-read-db";
import type { Cue } from "./cue-types";
import type { CuePositionContext } from "./cue-export";

/** 顺序只取 id；正文只取 Cue 起止锚点与 gap 后紧邻块。整批共享索引。 */
export async function loadCueExportContext(versionId: string, cues: Cue[]): Promise<CuePositionContext> {
  const order = await listTextBlockIdsByVersion(versionId);
  const blockIndexMap = new Map(order.map((id, index) => [id, index]));
  const nextBlockIdById = new Map(order.slice(0, -1).map((id, index) => [id, order[index + 1]]));
  const ids = new Set<string>();
  for (const cue of cues) {
    for (const anchor of [cue.start, cue.end]) {
      if (anchor.kind === "block") ids.add(anchor.blockId);
      else if (anchor.afterBlockId !== null) {
        ids.add(anchor.afterBlockId);
        const next = nextBlockIdById.get(anchor.afterBlockId);
        if (next) ids.add(next);
      }
    }
  }
  const blocks = await loadVersionBlocksByIds(versionId, [...ids]);
  const characters = await loadScriptCharacterNames(versionId, [...new Set(blocks.flatMap(block => block.characterIds))]);
  return {
    blockIndexMap, nextBlockIdById,
    blockMap: new Map(blocks.map(block => [block.id, block])),
    charMap: new Map(characters.map(character => [character.id, character.name])),
  };
}
