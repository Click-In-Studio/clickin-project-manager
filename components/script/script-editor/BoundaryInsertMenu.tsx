"use client";

export default function BoundaryInsertMenu({
  canAddChapterScene,
  canAddRehearsal,
  onAddChapter,
  onAddScene,
  onAddRehearsal,
  onConvertToChapter,
  onConvertToScene,
  onOpenSceneDetail,
}: {
  canAddChapterScene: boolean;
  canAddRehearsal: boolean;
  onAddChapter: () => void;
  onAddScene: () => void;
  onAddRehearsal: () => void;
  onConvertToChapter?: () => void;
  onConvertToScene?: () => void;
  onOpenSceneDetail?: () => void;
}) {
  const actions: Array<[string, () => void]> = [
    ...(canAddChapterScene ? [
      ["添加新章", onAddChapter] as [string, () => void],
      ["添加新段", onAddScene] as [string, () => void],
    ] : []),
    ...(canAddRehearsal ? [["添加新排练记号", onAddRehearsal] as [string, () => void]] : []),
  ];
  const conversionActions: Array<[string, () => void]> = [
    ...(onConvertToChapter ? [["转为章节", onConvertToChapter] as [string, () => void]] : []),
    ...(onConvertToScene ? [["转为段落", onConvertToScene] as [string, () => void]] : []),
  ];
  const renderAction = ([label, handler]: [string, () => void]) => (
    <button
      key={label}
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        handler();
      }}
      className="block w-full px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
    >
      {label}
    </button>
  );

  return (
    <div className="absolute left-0 top-full z-50 mt-1 w-36 rounded-lg border border-[var(--line)] bg-[var(--surface)] py-1 text-left shadow-xl">
      {actions.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] font-semibold tracking-wide text-zinc-400">在块前</div>
          {actions.map(renderAction)}
        </>
      )}
      {conversionActions.length > 0 && (
        <>
          {actions.length > 0 && <div className="my-1 h-px bg-zinc-100" />}
          <div className="px-3 py-1 text-[10px] font-semibold tracking-wide text-zinc-400">转换</div>
          {conversionActions.map(renderAction)}
        </>
      )}
      {onOpenSceneDetail && (
        <>
          {(actions.length > 0 || conversionActions.length > 0) && <div className="my-1 h-px bg-zinc-100" />}
          <div className="px-3 py-1 text-[10px] font-semibold tracking-wide text-zinc-400">详情</div>
          {renderAction(["查看构作详情", onOpenSceneDetail])}
        </>
      )}
    </div>
  );
}
