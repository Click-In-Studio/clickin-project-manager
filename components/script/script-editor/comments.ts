import type { Block, Character } from "@/lib/script/script-types";

export type RemotePresence = {
  clientId: string;
  userName: string;
  color: string;
  blockId: string | null;
};

export type Mention = { userId: string; name: string };

export type Comment = {
  id: string;
  productionId: string;
  contextType: string;
  contextId: string;
  parentId: string | null;
  userId: string;
  authorName: string;
  body: string;
  mentions: Mention[];
  createdAt: string;
  updatedAt: string;
};

export type CommentBlockCaption = {
  label: string;
  body: string;
};

export type SideBlockPanelNavigation = {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

export type BlockSidePanelKind = "comment" | "asset";

export type CommentDraft = {
  text: string;
  mentions: Mention[];
};

export type SideBlockPanelNavigationTargets = {
  previousBlockId: string | null;
  nextBlockId: string | null;
};

export type BlockAssetBubbleItem = {
  id: string;
  name: string | null;
  fileName: string;
};

export const EMPTY_COMMENTS: Comment[] = [];
export const EMPTY_BLOCK_ASSETS: BlockAssetBubbleItem[] = [];

export function buildCommentBlockCaption(block: Block, characters: Character[], displayNumber: number): CommentBlockCaption {
  const normalizedBlockContent = block.content.replace(/\s+/g, " ").trim();
  const blockContentPreview = normalizedBlockContent.slice(0, 20);
  const blockContentSuffix = normalizedBlockContent.length > blockContentPreview.length ? "..." : "";
  const characterCaption = block.type === "stage"
    ? ""
    : block.characterIds
        .map(id => characters.find(c => c.id === id)?.name)
        .filter((name): name is string => !!name)
        .join("/");

  return {
    label: `【${displayNumber}】`,
    body: `${characterCaption ? `${characterCaption}: ` : ""}${blockContentPreview || "（空）"}${blockContentSuffix}`,
  };
}

export function findSideBlockPanelNavigationTargets(
  blocks: Block[],
  activeBlockId: string | null,
  hasPanelItem: (blockId: string) => boolean,
): SideBlockPanelNavigationTargets {
  if (!activeBlockId) return { previousBlockId: null, nextBlockId: null };
  const activeIndex = blocks.findIndex(block => block.id === activeBlockId);
  if (activeIndex < 0) return { previousBlockId: null, nextBlockId: null };

  let previousBlockId: string | null = null;
  let nextBlockId: string | null = null;
  for (let index = activeIndex - 1; index >= 0; index--) {
    if (hasPanelItem(blocks[index].id)) {
      previousBlockId = blocks[index].id;
      break;
    }
  }
  for (let index = activeIndex + 1; index < blocks.length; index++) {
    if (hasPanelItem(blocks[index].id)) {
      nextBlockId = blocks[index].id;
      break;
    }
  }
  return { previousBlockId, nextBlockId };
}
